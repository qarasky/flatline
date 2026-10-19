//! Server-side metric threshold alerts (`metric-alerts.js`).
//!
//! Alert-only by contract: a breach never flips a monitor's status or
//! writes heartbeat rows. Evaluation reads the latest cached sample — the
//! values the server already derives — and a tiny state machine decides
//! when to speak:
//!
//! - debounce: the value must stay at or above the threshold for 60
//!   seconds; a one-second spike never pages anyone. Before the first alert
//!   of an episode, a reading below the threshold restarts the debounce —
//!   time in the hysteresis band is not "sustained breach" — and an
//!   observation gap longer than the tolerance (three monitor intervals, at
//!   least three minutes) breaks continuity: a value that reappears after
//!   silence starts a new episode.
//! - hysteresis: once an alert is active, recovery is declared at
//!   threshold - 5 points, so values hovering at the boundary do not flap.
//! - cooldown: while still breached, at most one repeat per 30 minutes.
//! - a recovery message is sent only when an alert for that breach actually
//!   went out; fully suppressed episodes stay silent.
//! - a missing reading never invents a recovery; gaps are handled by the
//!   continuity rule above, at the next observed value.
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
/// Base observation-gap tolerance: with no monitor interval to scale it, a
/// breach must have been observed within this window to still count as
/// continuous.
pub const GAP_TOLERANCE_MS: i64 = 3 * 60_000;
/// Minimum age a sample may have and still describe the present.
///
/// A buffered agent drains old readings quickly; evaluating those against
/// receive time would page for a historical spike — or announce a recovery
/// for a historical dip — while the host's present load has already moved
/// on. Backfill is still archived; only the alert decision is skipped. The
/// window scales with the monitor interval so slow pushers are not judged by
/// a 1Hz yardstick.
pub const MIN_FRESHNESS_MS: i64 = 60_000;
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
    /// When an at-or-above-threshold reading was last observed: the
    /// continuity anchor for the pre-alert debounce.
    last_above_at: Option<i64>,
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

    /// Pause a monitor's episodes because the readings stopped describing
    /// the present (stale telemetry). The debounce and its continuity anchor
    /// are dropped — old readings must not add up to a sustained-breach
    /// alert — while an already-fired alert stays open: staleness is not
    /// evidence of recovery. Live readings resume the debounce from scratch.
    pub fn pause(&mut self, monitor_id: i64) {
        if let Some(metrics) = self.monitors.get_mut(&monitor_id) {
            for state in metrics.values_mut() {
                state.breached_since = None;
                state.last_above_at = None;
            }
        }
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
///
/// `gap_tolerance_ms` is the longest observation gap that keeps a pre-alert
/// episode continuous.
pub fn step_metric(
    state: &mut MetricState,
    value: Option<f64>,
    threshold: f64,
    now_ms: i64,
    gap_tolerance_ms: i64,
) -> Option<Action> {
    // No reading (agent omitted the metric): never invent a recovery. A long
    // gap is caught by the continuity check below, at the next reading that
    // actually arrives.
    let value = value?;

    let recover_at = threshold - HYSTERESIS;
    if value <= recover_at {
        let was_alerted = state.alerted;
        state.breached_since = None;
        state.last_above_at = None;
        state.alerted = false;
        return was_alerted.then_some(Action::Recover);
    }

    if value < threshold {
        // Below the alert line. Once an alert is active this is the
        // hysteresis band: the episode stays open but stays silent. Before
        // any alert, sub-threshold time is not a sustained breach: the
        // debounce restarts, so two spikes separated by a dip cannot add up
        // to one 60s breach.
        if state.alerted {
            return None;
        }
        state.breached_since = None;
        state.last_above_at = None;
        return None;
    }

    // At or above the threshold.
    if !state.alerted
        && state
            .last_above_at
            .is_some_and(|last| now_ms - last > gap_tolerance_ms)
    {
        // The breach was not observed for most of the window (a silent
        // agent, dropped samples, a restarted collector): this reading
        // starts a new episode rather than completing the old one.
        state.breached_since = None;
    }
    state.last_above_at = Some(now_ms);

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

    let Some((sample_time, sample)) = metrics.sample(monitor.id) else {
        return;
    };

    // Alerts describe the present. A buffered agent draining a backlog
    // delivers old readings quickly; evaluating each against receive time
    // could satisfy the debounce with a historical high-load stretch (or
    // announce a recovery for a historical dip) after the host's load has
    // already moved on. Backfill is archived; stale samples only pause the
    // debounce, and live readings resume it.
    let freshness_ms = MIN_FRESHNESS_MS.max(monitor.interval.max(0) * 2 * 1000);
    let fresh = crate::metrics::metric_time(&sample_time)
        .is_some_and(|sampled_at| now_ms - sampled_at <= freshness_ms);
    if !fresh {
        metrics.alert_state.lock().unwrap().pause(monitor.id);
        return;
    }

    let (cpu, ram, disk, disk_mount) = readings_from(&sample);
    // Continuity scales with the monitor's cadence: one or two missed
    // samples are tolerated, a silence of three intervals is not. The base
    // tolerance covers monitors without a usable interval.
    let gap_tolerance_ms = GAP_TOLERANCE_MS.max(monitor.interval.max(0) * 3 * 1000);
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
                gap_tolerance_ms,
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
        let step = |state: &mut MetricState, value: Option<f64>, now: i64| {
            step_metric(state, value, 90.0, now, GAP_TOLERANCE_MS)
        };

        // A spike below the threshold: nothing.
        assert_eq!(step(&mut state, Some(89.0), t0), None);
        // At the threshold: the episode starts, still silent.
        assert_eq!(step(&mut state, Some(91.0), t0), None);
        // Debounce not elapsed.
        assert_eq!(step(&mut state, Some(95.0), t0 + 59_000), None);
        // Debounce elapsed: alert.
        let action = step(&mut state, Some(95.0), t0 + 61_000);
        assert_eq!(action, Some(Action::Alert));
        // Mark as notified like the evaluator does.
        state.alerted = true;
        state.last_notified = t0 + 61_000;
        // Still breached, but the cooldown holds.
        assert_eq!(step(&mut state, Some(95.0), t0 + 120_000), None);
        // Hysteresis band: above recovery, below the line; stays silent.
        assert_eq!(step(&mut state, Some(87.0), t0 + 130_000), None);
        // Cooldown elapsed while still breached: repeat.
        assert_eq!(
            step(&mut state, Some(95.0), t0 + 61_000 + COOLDOWN_MS),
            Some(Action::Alert)
        );
        // Recovery at threshold - 5.
        assert_eq!(
            step(&mut state, Some(85.0), t0 + 61_000 + COOLDOWN_MS + 1_000),
            Some(Action::Recover)
        );
        // A second recovery is silent.
        assert_eq!(
            step(&mut state, Some(80.0), t0 + 61_000 + COOLDOWN_MS + 2_000),
            None
        );
        // Missing readings never invent recoveries.
        let mut fresh = MetricState {
            alerted: true,
            ..Default::default()
        };
        assert_eq!(step(&mut fresh, None, t0), None);
        assert!(fresh.alerted);
    }

    #[test]
    fn debounce_requires_continuous_above_threshold_observations() {
        let t0 = 1_000_000_000_i64;
        let step = |state: &mut MetricState, value: Option<f64>, now: i64| {
            step_metric(state, value, 90.0, now, GAP_TOLERANCE_MS)
        };

        // The audit's reproduction: 95% @0s, 88% @1s, 95% @61s used to
        // alert on the last sample. Sub-threshold time restarts the
        // debounce, so it cannot add up to a "sustained" breach.
        let mut state = MetricState::default();
        assert_eq!(step(&mut state, Some(95.0), t0), None);
        assert_eq!(step(&mut state, Some(88.0), t0 + 1_000), None);
        assert_eq!(state.breached_since, None, "the dip restarts the debounce");
        assert_eq!(step(&mut state, Some(95.0), t0 + 61_000), None);
        // A fresh sustained episode from that reading alerts after a full
        // window.
        assert_eq!(
            step(&mut state, Some(95.0), t0 + 61_000 + DEBOUNCE_MS),
            Some(Action::Alert)
        );

        // A long observation gap breaks continuity: the reading that
        // reappears after the tolerance starts a new episode.
        let mut state = MetricState::default();
        assert_eq!(step(&mut state, Some(95.0), t0), None);
        assert_eq!(
            step(&mut state, Some(95.0), t0 + GAP_TOLERANCE_MS + 1),
            None
        );
        assert_eq!(
            step(
                &mut state,
                Some(95.0),
                t0 + GAP_TOLERANCE_MS + 1 + DEBOUNCE_MS
            ),
            Some(Action::Alert)
        );

        // One dropped sample is not a gap: a single missing reading does not
        // restart a breach that was observed across it.
        let mut state = MetricState::default();
        assert_eq!(step(&mut state, Some(95.0), t0), None);
        assert_eq!(step(&mut state, None, t0 + 1_000), None);
        assert_eq!(
            step(&mut state, Some(95.0), t0 + DEBOUNCE_MS),
            Some(Action::Alert)
        );
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
