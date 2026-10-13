//! Metrics ingest: validation, counter transforms, archive gating, the
//! live cache and the SSE `metrics` event (`monitor-metrics.js`).
//!
//! Latest state is cached per monitor; live pushes archive at 30s
//! resolution, legacy pushes archive every payload. Payloads are stored
//! with server-derived CPU percentages when the agent sends raw counters;
//! legacy percent-only payloads pass through untouched.

use std::collections::{HashMap, VecDeque};

use chrono::Utc;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::metrics::io_rates::{self, DiskMap, NetMap};
use crate::metrics::{HISTORY_INTERVAL_MS, Metrics, counters, metric_time, validate_metrics};

const MAX_LATEST: usize = 512;

#[derive(Clone)]
pub(crate) struct CounterSnapshot {
    pub counters: counters::CpuCounters,
    pub time: i64,
}

#[derive(Clone)]
pub(crate) struct NetSnapshot {
    pub snapshot: NetMap,
    pub time: i64,
}

#[derive(Clone)]
pub(crate) struct DiskSnapshot {
    pub snapshot: DiskMap,
    pub time: i64,
}

/// Everything the next sample needs from the previous one: the latest
/// sample itself, the archive clock, and the counter windows for the
/// derived transforms.
#[derive(Clone)]
pub(crate) struct LatestEntry {
    pub time: String,
    pub metrics: Value,
    pub time_ms: Option<i64>,
    pub persisted_at: i64,
    pub persisted_sample_time: Option<i64>,
    pub push_counters: Option<CounterSnapshot>,
    pub persisted_counters: Option<CounterSnapshot>,
    pub push_net: Option<NetSnapshot>,
    pub push_disk_io: Option<DiskSnapshot>,
}

#[derive(Default)]
pub(crate) struct LatestCache {
    pub entries: HashMap<i64, LatestEntry>,
    order: VecDeque<i64>,
}

impl LatestCache {
    pub fn remove(&mut self, monitor_id: i64) {
        self.entries.remove(&monitor_id);
        self.order.retain(|id| *id != monitor_id);
    }

    pub fn insert(&mut self, monitor_id: i64, entry: LatestEntry) {
        if !self.entries.contains_key(&monitor_id) {
            while self.entries.len() >= MAX_LATEST {
                match self.order.pop_front() {
                    Some(oldest) => {
                        self.entries.remove(&oldest);
                    }
                    None => break,
                }
            }
            self.order.push_back(monitor_id);
        }
        self.entries.insert(monitor_id, entry);
    }
}

impl Metrics {
    /// Store one metrics sample. `Err` carries the message the push route
    /// reports as "metrics dropped" — validation and storage failures
    /// alike, exactly like the Node function throwing.
    pub async fn store(
        &self,
        monitor_id: i64,
        time: &str,
        payload: &Value,
        live: bool,
    ) -> Result<(), String> {
        let encoded = validate_metrics(payload)?;
        let incoming_time = metric_time(time);
        let now = Utc::now().timestamp_millis();

        let previous = self
            .latest
            .lock()
            .unwrap()
            .entries
            .get(&monitor_id)
            .cloned();

        // An archive row is due when the wall clock says 30s have passed
        // since the last persist (normal live pacing) OR when the sample
        // clock says 30s of telemetry time have accumulated (a buffered
        // agent draining a backlog arrives quickly; its samples still
        // archive at their real cadence).
        let persist_due = !live
            || now
                - previous
                    .as_ref()
                    .map(|entry| entry.persisted_at)
                    .unwrap_or(0)
                >= HISTORY_INTERVAL_MS
            || incoming_time.is_some_and(|incoming| {
                previous
                    .as_ref()
                    .and_then(|entry| entry.persisted_sample_time)
                    .is_none_or(|last| incoming - last >= HISTORY_INTERVAL_MS)
            });

        let mut push_counters = previous
            .as_ref()
            .and_then(|entry| entry.push_counters.clone());
        let mut persisted_counters = previous
            .as_ref()
            .and_then(|entry| entry.persisted_counters.clone());
        let mut row_encoded = encoded.clone();
        let mut sample_metrics = payload.clone();

        // Server-side CPU derivation: live/latest uses the short window
        // since the previous push (responsive); the archived row uses the
        // long window since the previous persist (~30s, representative).
        // Anything incomputable keeps the agent values.
        if let Some(cur) = counters::as_counters(payload.get("cpu"))
            && let Some(incoming) = incoming_time
        {
            let ordered = previous
                .as_ref()
                .and_then(|entry| entry.push_counters.as_ref())
                .is_none_or(|snapshot| incoming >= snapshot.time);

            if ordered {
                if let Some(previous_counters) = previous
                    .as_ref()
                    .and_then(|entry| entry.push_counters.as_ref())
                    && let Some(derived) =
                        counters::transform_counters(Some(&previous_counters.counters), &cur)
                {
                    let mut for_latest = payload.clone();
                    counters::apply_derived_cpu(&mut for_latest, &derived);
                    sample_metrics = for_latest;
                }

                push_counters = Some(CounterSnapshot {
                    counters: cur.clone(),
                    time: incoming,
                });

                if persist_due {
                    if let Some(persisted) = previous
                        .as_ref()
                        .and_then(|entry| entry.persisted_counters.as_ref())
                        && let Some(derived) =
                            counters::transform_counters(Some(&persisted.counters), &cur)
                    {
                        let mut for_row = payload.clone();
                        counters::apply_derived_cpu(&mut for_row, &derived);
                        if let Ok(reencoded) = validate_metrics(&for_row) {
                            row_encoded = reencoded;
                        }
                    }
                    persisted_counters = Some(CounterSnapshot {
                        counters: cur,
                        time: incoming,
                    });
                }
            }
        }

        // Network and disk I/O rates: live-only — archived rows keep the
        // raw counters, which are lossless.
        let mut push_net = previous.as_ref().and_then(|entry| entry.push_net.clone());
        let mut push_disk_io = previous
            .as_ref()
            .and_then(|entry| entry.push_disk_io.clone());
        if let Some(incoming) = incoming_time {
            if let Some(cur) = io_rates::net_snapshot(&sample_metrics) {
                let ordered = previous
                    .as_ref()
                    .and_then(|entry| entry.push_net.as_ref())
                    .is_none_or(|snapshot| incoming >= snapshot.time);
                if ordered {
                    if let Some(previous_net) =
                        previous.as_ref().and_then(|entry| entry.push_net.as_ref())
                        && let Some(rate) = io_rates::net_rates(
                            &previous_net.snapshot,
                            &cur,
                            incoming - previous_net.time,
                        )
                    {
                        insert_derived(&mut sample_metrics, "netRate", &rate);
                    }
                    push_net = Some(NetSnapshot {
                        snapshot: cur,
                        time: incoming,
                    });
                }
            }

            if let Some(cur) = io_rates::disk_snapshot(&sample_metrics) {
                let ordered = previous
                    .as_ref()
                    .and_then(|entry| entry.push_disk_io.as_ref())
                    .is_none_or(|snapshot| incoming >= snapshot.time);
                if ordered {
                    if let Some(previous_io) = previous
                        .as_ref()
                        .and_then(|entry| entry.push_disk_io.as_ref())
                        && let Some(rate) = io_rates::disk_rates(
                            &previous_io.snapshot,
                            &cur,
                            incoming - previous_io.time,
                        )
                    {
                        insert_derived(&mut sample_metrics, "diskIoRate", &rate);
                    }
                    push_disk_io = Some(DiskSnapshot {
                        snapshot: cur,
                        time: incoming,
                    });
                }
            }
        }

        let mut persisted_at = previous
            .as_ref()
            .map(|entry| entry.persisted_at)
            .unwrap_or(0);
        let mut persisted_sample_time = previous
            .as_ref()
            .and_then(|entry| entry.persisted_sample_time);
        if persist_due {
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(time)
                .bind(&row_encoded)
                .execute(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
            persisted_at = now;
            if let Some(incoming) = incoming_time {
                persisted_sample_time = Some(incoming);
            }
        }

        // Latest cache: only newer samples win, and only they publish.
        let becomes_latest = {
            let cache = self.latest.lock().unwrap();
            match cache.entries.get(&monitor_id) {
                None => true,
                Some(entry) => match (incoming_time, entry.time_ms) {
                    (Some(new), Some(old)) => new >= old,
                    _ => false,
                },
            }
        };
        if !becomes_latest {
            return Ok(());
        }

        let percent = sample_metrics
            .get("cpu")
            .and_then(|cpu| cpu.get("percent"))
            .and_then(Value::as_f64);
        let peak = self
            .record_cpu_peak(monitor_id, incoming_time.unwrap_or(now), percent)
            .await;

        {
            let mut cache = self.latest.lock().unwrap();
            // Another push may have committed a newer latest sample while
            // the peak window was warming.
            if let Some(entry) = cache.entries.get(&monitor_id)
                && let (Some(new), Some(old)) = (incoming_time, entry.time_ms)
                && new < old
            {
                return Ok(());
            }
            cache.insert(
                monitor_id,
                LatestEntry {
                    time: time.to_string(),
                    metrics: sample_metrics.clone(),
                    time_ms: incoming_time,
                    persisted_at,
                    persisted_sample_time,
                    push_counters,
                    persisted_counters,
                    push_net,
                    push_disk_io,
                },
            );
        }

        // A restarted agent resets its counters. A stale ack would then hide
        // the first `ack` new failures, so drop it whenever the newest sample
        // reports a lower value than the stored one. Buffered older samples
        // never get here (only the latest sample reaches this point).
        if let Some(reported) = sample_metrics
            .pointer("/agent/failedPushes")
            .and_then(Value::as_u64)
        {
            let _ = sqlx::query(
                "UPDATE monitors SET push_failures_ack = 0 WHERE id = ? AND push_failures_ack > ?",
            )
            .bind(monitor_id)
            .bind(reported as i64)
            .execute(&self.pool)
            .await;
        }

        self.events.publish(json!({
            "type": "metrics",
            "monitorId": monitor_id,
            "time": time,
            "metrics": sample_metrics,
            "cpuPeak10m": peak,
        }));

        Ok(())
    }
}

/// Attach a derived rate to the sample payload.
fn insert_derived<T: serde::Serialize>(metrics: &mut Value, key: &str, rate: &T) {
    if let Some(object) = metrics.as_object_mut() {
        object.insert(
            key.to_string(),
            serde_json::to_value(rate).unwrap_or(Value::Null),
        );
    }
}

/// Warm the latest cache for a monitor from its newest archived row; used
/// by the API's database fallback path.
pub(crate) async fn load_latest(pool: &SqlitePool, monitor_id: i64) -> Option<(String, Value)> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT time, payload FROM metrics_raw WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1",
    )
    .bind(monitor_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let (time, payload) = row?;
    let metrics = serde_json::from_str(&payload).ok()?;
    Some((time, metrics))
}
