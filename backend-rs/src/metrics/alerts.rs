//! Server-side metric threshold alerts (`metric-alerts.js`).
//!
//! Alert-only by contract: a breach never flips a monitor's status or
//! writes heartbeat rows. Evaluation reads the latest cached sample — the
//! values the server already derives — and a tiny state machine decides
//! when to speak:
//!
//! - debounce: the value must stay at or above the threshold for 60
//!   seconds; a one-second spike never pages anyone.
//! - hysteresis: recovery is declared at threshold - 5 points, so values
//!   hovering at the boundary do not flap.
//! - cooldown: while still breached, at most one repeat per 30 minutes.
//! - a recovery message is sent only when an alert for that breach actually
//!   went out; fully suppressed episodes stay silent.
//!
//! State is in-memory and bounded; a restart may re-send one alert after
//! the debounce. Evaluation uses receive time, not `sampledAt`, so a
//! backfilled backlog cannot replay old alert timelines.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::metrics::Metrics;
use crate::monitors::Monitor;
use crate::notify;

pub const DEBOUNCE_MS: i64 = 60_000;
pub const COOLDOWN_MS: i64 = 30 * 60_000;
pub const HYSTERESIS: f64 = 5.0;
const MAX_STATE: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Alert,
    Recover,
}

#[derive(Default, Clone, Copy)]
pub struct MetricState {
    breached_since: Option<i64>,
    alerted: bool,
    last_notified: i64,
}

#[derive(Default)]
pub struct AlertState {
    monitors: HashMap<i64, HashMap<String, MetricState>>,
    order: VecDeque<i64>,
}

impl AlertState {
    pub fn slot(&mut self, monitor_id: i64, metric: &str) -> &mut MetricState {
        if !self.monitors.contains_key(&monitor_id) {
            if self.monitors.len() >= MAX_STATE
                && let Some(oldest) = self.order.pop_front()
            {
                self.monitors.remove(&oldest);
            }
            self.order.push_back(monitor_id);
            self.monitors.insert(monitor_id, HashMap::new());
        }
        self.monitors
            .get_mut(&monitor_id)
            .expect("just inserted")
            .entry(metric.to_string())
            .or_default()
    }

    pub fn forget(&mut self, monitor_id: i64) {
        self.monitors.remove(&monitor_id);
        self.order.retain(|id| *id != monitor_id);
    }
}

/// Extract readings from one decoded metrics payload. The disk reading is
/// the fullest mount.
pub fn readings_from(metrics: &Value) -> (Option<f64>, Option<f64>, Option<f64>, Option<String>) {
    let finite = |value: Option<&Value>| value.and_then(Value::as_f64).filter(|v| v.is_finite());

    let cpu = finite(metrics.get("cpu").and_then(|cpu| cpu.get("percent")));
    let ram = finite(metrics.get("mem").and_then(|mem| mem.get("percent")));

    let mut disk = None;
    let mut disk_mount = None;
    if let Some(mounts) = metrics.get("disk").and_then(Value::as_array) {
        for mount in mounts {
            if let Some(percent) = finite(mount.get("percent"))
                && disk.is_none_or(|current| percent > current)
            {
                disk = Some(percent);
                disk_mount = mount
                    .get("mount")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
    }

    (cpu, ram, disk, disk_mount)
}

/// Pure state-machine step for one metric. Mutates `state`, returns the
/// action to take, if any.
pub fn step_metric(
    state: &mut MetricState,
    value: Option<f64>,
    threshold: f64,
    now_ms: i64,
) -> Option<Action> {
    // No reading (agent omitted the metric): leave the episode alone rather
    // than inventing a recovery.
    let value = value?;

    let recover_at = threshold - HYSTERESIS;
    if value <= recover_at {
        let was_alerted = state.alerted;
        state.breached_since = None;
        state.alerted = false;
        return was_alerted.then_some(Action::Recover);
    }

    if value < threshold {
        // Hysteresis band: above recovery, below the alert line. The episode
        // stays open but stays silent.
        return None;
    }

    let Some(breached_since) = state.breached_since else {
        state.breached_since = Some(now_ms);
        return None;
    };
    if now_ms - breached_since < DEBOUNCE_MS {
        return None;
    }
    if !state.alerted {
        return Some(Action::Alert);
    }
    (now_ms - state.last_notified >= COOLDOWN_MS).then_some(Action::Alert)
}

/// Metric alert in the same bracketed shape as the heartbeat alerts:
///
/// ```text
/// [⚠️ METRIC] [work / MEKS] [modernization-meks]
/// [cpu] [94.2% ≥ threshold 90%]
/// ```
pub fn format_metric_message(
    group: Option<&str>,
    monitor_name: &str,
    metric: &str,
    mount: Option<&str>,
    value: f64,
    threshold: i64,
    action: Action,
) -> String {
    let group = group.unwrap_or("Ungrouped");
    let target = if metric == "disk" {
        match mount {
            Some(mount) => format!("Disk {mount}"),
            None => "Disk".to_string(),
        }
    } else {
        match metric {
            "cpu" => "CPU".to_string(),
            "ram" => "RAM".to_string(),
            other => other.to_string(),
        }
    };
    let rounded = (value * 10.0).round() / 10.0;

    let (tag, detail) = if action == Action::Recover {
        (
            "✅ METRIC",
            format!("{target} recovered: {rounded}% (threshold {threshold}%)"),
        )
    } else {
        (
            "⚠️ METRIC",
            format!("{target} {rounded}% ≥ threshold {threshold}%"),
        )
    };
    format!("[{tag}] [{group}] [{monitor_name}]\n[{metric}] [{detail}]")
}

/// Evaluate one monitor's latest sample against its thresholds.
pub(crate) async fn evaluate(metrics: &Metrics, monitor: &Monitor, now_ms: i64) {
    let thresholds = [
        ("cpu", monitor.metric_cpu_threshold),
        ("ram", monitor.metric_ram_threshold),
        ("disk", monitor.metric_disk_threshold),
    ];
    if thresholds.iter().all(|(_, threshold)| threshold.is_none()) {
        return;
    }

    let Some((_, sample)) = metrics.sample(monitor.id) else {
        return;
    };

    let (cpu, ram, disk, disk_mount) = readings_from(&sample);
    for (metric, threshold) in thresholds {
        let Some(threshold) = threshold else {
            continue;
        };
        let value = match metric {
            "cpu" => cpu,
            "ram" => ram,
            _ => disk,
        };

        let action = {
            let mut state = metrics.alert_state.lock().unwrap();
            step_metric(
                state.slot(monitor.id, metric),
                value,
                threshold as f64,
                now_ms,
            )
        };
        let Some(action) = action else {
            continue;
        };

        if action == Action::Alert {
            let mut state = metrics.alert_state.lock().unwrap();
            let slot = state.slot(monitor.id, metric);
            slot.alerted = true;
            slot.last_notified = now_ms;
        }

        let group = notify::group_path(&metrics.pool, monitor.parent).await;
        let message = format_metric_message(
            group.as_deref(),
            &monitor.name,
            metric,
            disk_mount.as_deref(),
            value.unwrap_or(0.0),
            threshold,
            action,
        );
        notify::dispatch_message(&metrics.pool, &metrics.client, monitor.id, message).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn readings_take_the_fullest_disk() {
        let metrics = json!({
            "cpu": { "percent": 42.5 },
            "mem": { "percent": 70.0 },
            "disk": [
                { "mount": "/", "percent": 55.5 },
                { "mount": "/data", "percent": 91.25 },
                { "mount": "/broken" }
            ]
        });
        let (cpu, ram, disk, mount) = readings_from(&metrics);
        assert_eq!(cpu, Some(42.5));
        assert_eq!(ram, Some(70.0));
        assert_eq!(disk, Some(91.25));
        assert_eq!(mount.as_deref(), Some("/data"));

        let (cpu, ram, disk, mount) = readings_from(&json!({}));
        assert!(cpu.is_none() && ram.is_none() && disk.is_none() && mount.is_none());
    }

    #[test]
    fn state_machine_debounces_hysteresis_and_cools_down() {
        let mut state = MetricState::default();
        let t0 = 1_000_000_000_i64;

        // A spike below the threshold: nothing.
        assert_eq!(step_metric(&mut state, Some(89.0), 90.0, t0), None);
        // At the threshold: the episode starts, still silent.
        assert_eq!(step_metric(&mut state, Some(91.0), 90.0, t0), None);
        // Debounce not elapsed.
        assert_eq!(step_metric(&mut state, Some(95.0), 90.0, t0 + 59_000), None);
        // Debounce elapsed: alert.
        let action = step_metric(&mut state, Some(95.0), 90.0, t0 + 61_000);
        assert_eq!(action, Some(Action::Alert));
        // Mark as notified like the evaluator does.
        state.alerted = true;
        state.last_notified = t0 + 61_000;
        // Still breached, but the cooldown holds.
        assert_eq!(
            step_metric(&mut state, Some(95.0), 90.0, t0 + 120_000),
            None
        );
        // Hysteresis band: above recovery, below the line; stays silent.
        assert_eq!(
            step_metric(&mut state, Some(87.0), 90.0, t0 + 130_000),
            None
        );
        // Cooldown elapsed while still breached: repeat.
        assert_eq!(
            step_metric(&mut state, Some(95.0), 90.0, t0 + 61_000 + COOLDOWN_MS),
            Some(Action::Alert)
        );
        // Recovery at threshold - 5.
        assert_eq!(
            step_metric(
                &mut state,
                Some(85.0),
                90.0,
                t0 + 61_000 + COOLDOWN_MS + 1_000
            ),
            Some(Action::Recover)
        );
        // A second recovery is silent.
        assert_eq!(
            step_metric(
                &mut state,
                Some(80.0),
                90.0,
                t0 + 61_000 + COOLDOWN_MS + 2_000
            ),
            None
        );
        // Missing readings never invent recoveries.
        let mut fresh = MetricState {
            alerted: true,
            ..Default::default()
        };
        assert_eq!(step_metric(&mut fresh, None, 90.0, t0), None);
        assert!(fresh.alerted);
    }

    #[test]
    fn messages_use_the_bracketed_alert_shape() {
        assert_eq!(
            format_metric_message(
                Some("work / MEKS"),
                "cmn",
                "cpu",
                None,
                94.2,
                90,
                Action::Alert
            ),
            "[⚠️ METRIC] [work / MEKS] [cmn]\n[cpu] [CPU 94.2% ≥ threshold 90%]"
        );
        assert_eq!(
            format_metric_message(
                None,
                "cmn",
                "disk",
                Some("/data"),
                91.0,
                90,
                Action::Recover
            ),
            "[✅ METRIC] [Ungrouped] [cmn]\n[disk] [Disk /data recovered: 91% (threshold 90%)]"
        );
    }
}
