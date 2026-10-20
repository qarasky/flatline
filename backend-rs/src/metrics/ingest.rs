//! Metrics ingest: validation, counter transforms, archive gating, the
//! live cache and the SSE `metrics` event (`monitor-metrics.js`).
//!
//! Latest state is cached per monitor; live pushes archive at 30s
//! resolution, legacy pushes archive every payload. Payloads are stored
//! with server-derived CPU percentages when the agent sends raw counters;
//! legacy percent-only payloads pass through untouched.

use std::collections::HashMap;
use std::fmt;

use chrono::Utc;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::metrics::io_rates::{self, DiskMap, NetMap};
use crate::metrics::lru::{CACHE_MONITORS, Recency};
use crate::metrics::{HISTORY_INTERVAL_MS, Metrics, counters, metric_time, validate_metrics};

/// Why a sample was not stored. The push route answers the two kinds
/// differently: a payload problem is permanent (400, the agent quarantines
/// it), a storage problem is transient (503 + `Retry-After`, the agent keeps
/// the sample and retries).
#[derive(Debug)]
pub enum StoreError {
    /// The payload itself was rejected; retrying it fails identically.
    Invalid(String),
    /// The database refused the write (lock timeout, disk full, ...).
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Invalid(message) | StoreError::Storage(message) => f.write_str(message),
        }
    }
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        StoreError::Storage(error.to_string())
    }
}

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
    /// The on-time hour this monitor already left a dirty marker for, so an
    /// on-time sample writes at most one marker per hour.
    pub marked_hour: Option<i64>,
    /// An ack-reset write failed; re-run the ack checks on the next sample.
    pub ack_recheck: bool,
}

/// The latest-sample cache: bounded, least-recently-updated evicted first.
#[derive(Default)]
pub(crate) struct LatestCache {
    pub entries: HashMap<i64, LatestEntry>,
    order: Recency,
}

impl LatestCache {
    pub fn remove(&mut self, monitor_id: i64) {
        self.entries.remove(&monitor_id);
        self.order.remove(monitor_id);
    }

    /// Insert or update an entry; either way it becomes the most recent.
    pub fn insert(&mut self, monitor_id: i64, entry: LatestEntry) {
        if !self.entries.contains_key(&monitor_id) {
            while self.entries.len() >= CACHE_MONITORS {
                match self.order.pop_oldest() {
                    Some(oldest) => {
                        self.entries.remove(&oldest);
                    }
                    None => break,
                }
            }
        }
        self.order.touch(monitor_id);
        self.entries.insert(monitor_id, entry);
    }
}

impl Metrics {
    /// Store one metrics sample, serialized per monitor.
    ///
    /// The archive gate, the counter windows and the latest-cache update are
    /// read-modify-write sequences separated by awaits; concurrent pushes
    /// for one monitor used to interleave them (ten concurrent live samples
    /// produced ten archive rows instead of one, and counter windows could
    /// derive from an obsolete previous sample). One guard per monitor keeps
    /// them in arrival order; different monitors stay concurrent.
    pub async fn store(
        &self,
        monitor_id: i64,
        time: &str,
        payload: &Value,
        live: bool,
    ) -> Result<(), StoreError> {
        let _guard = self.ingest_guard(monitor_id).await;
        self.store_locked(monitor_id, time, payload, live).await
    }

    /// Store one metrics sample. `Err` says whether the payload was refused
    /// ([`StoreError::Invalid`]) or the database failed
    /// ([`StoreError::Storage`]); the push route maps them to 400 and 503.
    async fn store_locked(
        &self,
        monitor_id: i64,
        time: &str,
        payload: &Value,
        live: bool,
    ) -> Result<(), StoreError> {
        let encoded = validate_metrics(payload).map_err(StoreError::Invalid)?;
        let incoming_time = metric_time(time);
        let now = Utc::now().timestamp_millis();

        let previous = self
            .latest
            .lock()
            .unwrap()
            .entries
            .get(&monitor_id)
            .cloned();

        // A monitor that is not cached (first sample since boot, or evicted)
        // takes its archive clock from its newest archived row; otherwise
        // every push would archive until the clock re-warmed. Best effort: a
        // failed read only means this sample archives.
        let archived_clock = match &previous {
            Some(_) => None,
            None => newest_archived_time(&self.pool, monitor_id).await,
        };

        // An archive row is due when the wall clock says 30s have passed
        // since the last persist (normal live pacing) OR when the sample
        // clock says 30s of telemetry time have accumulated (a buffered
        // agent draining a backlog arrives quickly; its samples still
        // archive at their real cadence).
        let previous_persisted_at = previous
            .as_ref()
            .map(|entry| entry.persisted_at)
            .or(archived_clock)
            .unwrap_or(0);
        let previous_persisted_sample_time = previous
            .as_ref()
            .and_then(|entry| entry.persisted_sample_time)
            .or(archived_clock);
        let persist_due = !live
            || now - previous_persisted_at >= HISTORY_INTERVAL_MS
            || incoming_time.is_some_and(|incoming| {
                previous_persisted_sample_time
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

        let mut persisted_at = previous_persisted_at;
        let mut persisted_sample_time = previous_persisted_sample_time;
        let mut marked_hour = previous.as_ref().and_then(|entry| entry.marked_hour);
        if persist_due {
            // The hour this raw row belongs to may already have been folded:
            // buffered agents backfill arbitrary ages, so a late row marks its
            // hour dirty and the next rollup run re-folds it from the raw
            // evidence. An on-time row (current hour) marks its hour once per
            // hour, which covers a rollup run missed while the process was
            // down. The marker commits with the row: a row can never land
            // without its marker, and the 30 s archive cadence costs one
            // commit instead of two.
            let row_hour = crate::metrics::rollup::hour_start(incoming_time.unwrap_or(now));
            let late = row_hour < crate::metrics::rollup::hour_start(now);
            let mark = late || marked_hour != Some(row_hour);

            let mut tx = self.pool.begin().await?;
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(time)
                .bind(&row_encoded)
                .execute(&mut *tx)
                .await?;
            if mark {
                // REPLACE, not IGNORE: the marker gets a fresh id, so a rollup
                // run that read the old marker before this row landed does not
                // delete this one (it only deletes the markers it read).
                sqlx::query(
                    "INSERT OR REPLACE INTO metrics_rollup_dirty (monitor_id, hour) VALUES (?, ?)",
                )
                .bind(monitor_id)
                .bind(crate::metrics::sql_time_millis(row_hour))
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;

            if mark && !late {
                marked_hour = Some(row_hour);
            }
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
                    marked_hour,
                    ack_recheck: false,
                },
            );
        }

        if self
            .reset_stale_acks(monitor_id, previous.as_ref(), &sample_metrics)
            .await
            .is_err()
            && let Some(entry) = self.latest.lock().unwrap().entries.get_mut(&monitor_id)
        {
            entry.ack_recheck = true;
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

    /// Drop agent-warning acks that a restarted agent made stale.
    ///
    /// Runs only when a counter moved backwards since the previous latest
    /// sample (or there is no previous sample to compare with, or a previous
    /// reset failed): at 1 Hz the unconditional UPDATEs were a write
    /// statement per push that almost never changed anything.
    async fn reset_stale_acks(
        &self,
        monitor_id: i64,
        previous: Option<&LatestEntry>,
        sample_metrics: &Value,
    ) -> sqlx::Result<()> {
        let recheck = previous.is_none_or(|entry| entry.ack_recheck);
        let previous_agent = previous.and_then(|entry| entry.metrics.get("agent"));
        let moved_back = |key: &str, reported: u64| {
            recheck
                || previous_agent
                    .and_then(|agent| agent.get(key))
                    .and_then(Value::as_u64)
                    .is_none_or(|before| reported < before)
        };
        let mut outcome = Ok(());

        // A restarted agent resets its counters. A stale ack would then hide
        // the first `ack` new failures, so drop it whenever the newest sample
        // reports a lower value than the stored one. Buffered older samples
        // never get here (only the latest sample reaches this point).
        if let Some(reported) = sample_metrics
            .pointer("/agent/failedPushes")
            .and_then(Value::as_u64)
            && moved_back("failedPushes", reported)
            && let Err(error) = sqlx::query(
                "UPDATE monitors SET push_failures_ack = 0 WHERE id = ? AND push_failures_ack > ?",
            )
            .bind(monitor_id)
            .bind(reported.min(i64::MAX as u64) as i64)
            .execute(&self.pool)
            .await
        {
            outcome = Err(error);
        }

        // The same restart rule for the other two agent-warning counters.
        if let Some(reported) = sample_metrics
            .pointer("/agent/samplesDropped")
            .and_then(Value::as_u64)
            && moved_back("samplesDropped", reported)
            && let Err(error) = sqlx::query(
                "UPDATE monitors SET samples_dropped_ack = 0 WHERE id = ? AND samples_dropped_ack > ?",
            )
            .bind(monitor_id)
            .bind(reported.min(i64::MAX as u64) as i64)
            .execute(&self.pool)
            .await
        {
            outcome = Err(error);
        }

        // Collector errors are a map, so the ack is dropped key by key: keep
        // only the collectors still reporting at least what was acknowledged.
        // Checked only when some collector's count went down or vanished.
        if let Some(reported) = sample_metrics
            .pointer("/agent/collectorErrors")
            .and_then(Value::as_object)
        {
            let shrank = recheck
                || previous_agent
                    .and_then(|agent| agent.get("collectorErrors"))
                    .and_then(Value::as_object)
                    .is_none_or(|before| {
                        before.iter().any(|(name, count)| {
                            reported.get(name).and_then(Value::as_u64)
                                < count.as_u64().or(Some(0))
                        })
                    });
            if shrank && let Err(error) = self.reset_collector_acks(monitor_id, reported).await {
                outcome = Err(error);
            }
        }

        if let Err(error) = &outcome {
            tracing::warn!("agent ack reset failed for monitor {monitor_id}: {error}");
        }
        outcome
    }

    async fn reset_collector_acks(
        &self,
        monitor_id: i64,
        reported: &serde_json::Map<String, Value>,
    ) -> sqlx::Result<()> {
        let stored: Option<String> =
            sqlx::query_scalar("SELECT collector_errors_ack FROM monitors WHERE id = ?")
                .bind(monitor_id)
                .fetch_optional(&self.pool)
                .await?;
        let Some(acked) = stored
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned())
            .filter(|acked| !acked.is_empty())
        else {
            return Ok(());
        };
        let total = acked.len();
        let kept: serde_json::Map<String, Value> = acked
            .into_iter()
            .filter(|(name, acked)| {
                reported
                    .get(name)
                    .and_then(Value::as_u64)
                    .is_some_and(|now| now >= acked.as_u64().unwrap_or(0))
            })
            .collect();
        if kept.len() != total {
            sqlx::query("UPDATE monitors SET collector_errors_ack = ? WHERE id = ?")
                .bind(Value::Object(kept).to_string())
                .bind(monitor_id)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }
}

/// The sample time of a monitor's newest archived row, as epoch millis.
async fn newest_archived_time(pool: &SqlitePool, monitor_id: i64) -> Option<i64> {
    let time: Option<String> = sqlx::query_scalar(
        "SELECT time FROM metrics_raw WHERE monitor_id = ? ORDER BY time DESC LIMIT 1",
    )
    .bind(monitor_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    time.as_deref().and_then(metric_time)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> LatestEntry {
        LatestEntry {
            time: String::new(),
            metrics: json!({}),
            time_ms: None,
            persisted_at: 0,
            persisted_sample_time: None,
            push_counters: None,
            persisted_counters: None,
            push_net: None,
            push_disk_io: None,
            marked_hour: None,
            ack_recheck: false,
        }
    }

    #[test]
    fn latest_cache_evicts_the_least_recently_updated() {
        let mut cache = LatestCache::default();
        for id in 0..CACHE_MONITORS as i64 {
            cache.insert(id, entry());
        }
        // Monitor 0 was inserted first but keeps pushing; monitor 1 went
        // quiet. Insertion-order eviction dropped 0 here.
        cache.insert(0, entry());
        cache.insert(CACHE_MONITORS as i64, entry());

        assert_eq!(cache.entries.len(), CACHE_MONITORS);
        assert!(cache.entries.contains_key(&0), "the active monitor stays");
        assert!(!cache.entries.contains_key(&1), "the idle one is evicted");

        cache.remove(0);
        cache.insert(CACHE_MONITORS as i64 + 1, entry());
        assert!(
            cache.entries.contains_key(&2),
            "a removed entry frees its slot instead of evicting another"
        );
    }
}
