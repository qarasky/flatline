//! The metrics pipeline: ingest, transforms, live cache, CPU peak tracking,
//! threshold alerts, history summaries and hourly rollups.
//!
//! Ported one-for-one from the Node modules (`monitor-metrics.js`,
//! `cpu-counters.js`, `io-rates.js`, `cpu-peak.js`, `metric-alerts.js`,
//! `metrics-history.js`, `metrics-rollup.js`) so the Superboard and the SPA
//! read the same numbers in the same shapes.

pub mod alerts;
pub mod counters;
pub mod history;
pub mod ingest;
pub mod io_rates;
pub mod peak;
pub mod rollup;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, NaiveDateTime, Timelike, Utc};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::events::Events;
use crate::monitors::Monitor;

/// Maximum accepted payload size in bytes; matches the Node constant and
/// sits below the push route's 256kb transport cap.
pub const METRICS_MAX_BYTES: usize = 64 * 1024;
/// How long raw samples are kept, in days.
pub const METRICS_RETENTION_DAYS: i64 = 30;
/// Archive cadence for live telemetry, in milliseconds.
pub const HISTORY_INTERVAL_MS: i64 = 30_000;

/// Process-local metrics state: the latest-sample cache (with the counters
/// and rate windows it needs), the CPU peak tracker and the threshold-alert
/// state machines. Everything here is bounded; a restart just warms again.
pub struct Metrics {
    pub(crate) pool: SqlitePool,
    pub(crate) events: Arc<Events>,
    pub(crate) client: reqwest::Client,
    pub(crate) latest: Mutex<ingest::LatestCache>,
    pub(crate) peak: Mutex<peak::PeakState>,
    pub(crate) alert_state: Mutex<alerts::AlertState>,
    /// One async lock per monitor: the ingest path reads the archive gate,
    /// counter windows and latest cache, awaits storage, then updates them —
    /// concurrent pushes for one monitor must not interleave those steps
    /// (duplicate archive rows, counter windows derived from an obsolete
    /// previous sample).
    pub(crate) ingest_locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
}

impl Metrics {
    pub fn new(pool: SqlitePool, events: Arc<Events>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            events,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            latest: Mutex::new(ingest::LatestCache::default()),
            peak: Mutex::new(peak::PeakState::default()),
            alert_state: Mutex::new(alerts::AlertState::default()),
            ingest_locks: Mutex::new(HashMap::new()),
        })
    }

    /// Acquire the monitor's ingest lock, creating it on first use.
    pub(crate) async fn ingest_guard(&self, monitor_id: i64) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.ingest_locks.lock().unwrap();
            Arc::clone(
                locks
                    .entry(monitor_id)
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        lock.lock_owned().await
    }

    /// Drop every cached trace of a monitor (deletion).
    pub fn forget(&self, monitor_id: i64) {
        self.latest.lock().unwrap().remove(monitor_id);
        self.peak.lock().unwrap().forget(monitor_id);
        self.alert_state.lock().unwrap().forget(monitor_id);
        self.ingest_locks.lock().unwrap().remove(&monitor_id);
    }

    /// The cached sample, API-shaped: `{time, metrics, cpuPeak10m}`.
    pub fn latest_json(&self, monitor_id: i64) -> Option<Value> {
        let (time, metrics) = {
            let cache = self.latest.lock().unwrap();
            let entry = cache.entries.get(&monitor_id)?;
            (entry.time.clone(), entry.metrics.clone())
        };
        let peak = self
            .peak
            .lock()
            .unwrap()
            .current(monitor_id, Utc::now().timestamp_millis());
        Some(json!({
            "time": time,
            "metrics": metrics,
            "cpuPeak10m": peak,
        }))
    }

    /// The cached sample the alert evaluator reads.
    pub(crate) fn sample(&self, monitor_id: i64) -> Option<(String, Value)> {
        let cache = self.latest.lock().unwrap();
        let entry = cache.entries.get(&monitor_id)?;
        Some((entry.time.clone(), entry.metrics.clone()))
    }

    /// Threshold alerts at the current wall clock.
    pub async fn evaluate_alerts(&self, monitor: &Monitor) {
        self.evaluate_alerts_at(monitor, Utc::now().timestamp_millis())
            .await;
    }

    /// Fire-and-forget variant for the push route: a broken alert must
    /// never fail an ingest.
    pub fn evaluate_alerts_async(self: &Arc<Self>, monitor: &Monitor) {
        let metrics = Arc::clone(self);
        let monitor = monitor.clone();
        tokio::spawn(async move {
            metrics.evaluate_alerts(&monitor).await;
        });
    }

    /// Threshold alerts at a given clock (tests).
    pub async fn evaluate_alerts_at(&self, monitor: &Monitor, now_ms: i64) {
        alerts::evaluate(self, monitor, now_ms).await;
    }

    /// Background jobs: hourly rollups at :12 past the hour (which fold and
    /// then prune the raw rows that are proven folded — one maintenance run,
    /// so a failed fold can never race a delete) and heartbeat retention once
    /// at startup and daily at 04:32.
    ///
    /// `heartbeat_retention_days` comes from the configuration; 0 keeps
    /// heartbeats forever. The handles let shutdown stop the jobs.
    pub fn start_jobs(
        self: &Arc<Self>,
        heartbeat_retention_days: i64,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        let metrics = Arc::clone(self);
        let rollups = tokio::spawn(async move {
            loop {
                sleep_until(next_hourly_at(Utc::now(), 12)).await;
                match rollup::rollup_metrics(&metrics.pool, Utc::now().timestamp_millis()).await {
                    Ok(result)
                        if result.rolled_up > 0
                            || result.pruned > 0
                            || result.pruned_raw > 0
                            || result.skipped_raw > 0 =>
                    {
                        tracing::info!(
                            "rollup: {} hour buckets ({} chunks, {} hours verified), pruned {} expired \
                             buckets, pruned {} folded raw hours, kept {} unfolded",
                            result.rolled_up,
                            result.chunks,
                            result.verified_hours,
                            result.pruned,
                            result.pruned_raw,
                            result.skipped_raw
                        );
                    }
                    Ok(_) => {}
                    Err(error) => tracing::error!("rollup failed: {error}"),
                }
            }
        });

        // Heartbeats grow with every check and had no retention at all. The
        // first pass runs at startup (an imported database can carry years),
        // then daily just after the raw metrics prune.
        let metrics = Arc::clone(self);
        let retention = tokio::spawn(async move {
            loop {
                match crate::heartbeats::prune(&metrics.pool, heartbeat_retention_days).await {
                    Ok(deleted) if deleted > 0 => {
                        tracing::info!(
                            "pruned {deleted} heartbeats older than {heartbeat_retention_days} days"
                        );
                    }
                    Ok(_) => {}
                    Err(error) => tracing::error!("heartbeat prune failed: {error}"),
                }
                sleep_until(next_daily_at(Utc::now(), 4, 32)).await;
            }
        });
        vec![rollups, retention]
    }
}

async fn sleep_until(next: DateTime<Utc>) {
    let wait = (next - Utc::now()).num_milliseconds().max(1000) as u64;
    tokio::time::sleep(Duration::from_millis(wait)).await;
}

/// The next occurrence of `minute` past the hour (UTC).
fn next_hourly_at(now: DateTime<Utc>, minute: u32) -> DateTime<Utc> {
    let candidate = now
        .with_minute(minute)
        .unwrap_or(now)
        .with_second(0)
        .unwrap_or(now)
        .with_nanosecond(0)
        .unwrap_or(now);
    if candidate > now {
        candidate
    } else {
        candidate + chrono::Duration::hours(1)
    }
}

/// The next occurrence of `hour:minute` (UTC), today or tomorrow.
fn next_daily_at(now: DateTime<Utc>, hour: u32, minute: u32) -> DateTime<Utc> {
    let candidate = now
        .with_hour(hour)
        .unwrap_or(now)
        .with_minute(minute)
        .unwrap_or(now)
        .with_second(0)
        .unwrap_or(now)
        .with_nanosecond(0)
        .unwrap_or(now);
    if candidate > now {
        candidate
    } else {
        candidate + chrono::Duration::days(1)
    }
}

/// Parse a stored timestamp (SQL or ISO, with or without a zone) into epoch
/// millis, mirroring the Node `metricTime`.
pub fn metric_time(value: &str) -> Option<i64> {
    let text = value.replace(' ', "T");
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&text) {
        return Some(parsed.timestamp_millis());
    }
    let naive = text.trim_end_matches(['Z', 'z']);
    NaiveDateTime::parse_from_str(naive, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(naive, "%Y-%m-%dT%H:%M:%S"))
        .ok()
        .map(|parsed| parsed.and_utc().timestamp_millis())
}

/// Format epoch millis the way the database stores times (SQL, UTC).
pub fn sql_time_millis(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

/// ISO-8601 with milliseconds, matching `new Date(ms).toISOString()`.
pub fn iso_millis(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Validate a metrics payload without interpreting it. Unknown fields are
/// ignored, never rejected: the `v` envelope lets future agents add fields
/// without breaking old servers.
pub fn validate_metrics(payload: &Value) -> Result<String, String> {
    if !payload.is_object() {
        return Err("metrics must be a JSON object".to_string());
    }
    let encoded = serde_json::to_string(payload)
        .map_err(|error| format!("metrics must be a JSON object: {error}"))?;
    if encoded.len() > METRICS_MAX_BYTES {
        return Err(format!("metrics payload exceeds {METRICS_MAX_BYTES} bytes"));
    }
    Ok(encoded)
}

/// Resolve an agent-supplied sample time, if it is trustworthy.
///
/// Buffered agents deliver telemetry late and carry the time each sample was
/// actually taken. Use it when present so a backfilled history is honest;
/// reject it when absent, unparseable, obviously in the future (clock skew),
/// or older than the retention window. The caller falls back to receive
/// time; the clock authority stays the server.
pub fn resolve_sample_time(sampled_at: Option<&Value>, now_ms: i64) -> Option<String> {
    let raw = sampled_at?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = metric_time(raw)?;
    if parsed > now_ms + 5 * 60_000 {
        return None;
    }
    if parsed < now_ms - METRICS_RETENTION_DAYS * 24 * 3_600_000 {
        return None;
    }
    Some(sql_time_millis(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_time_accepts_sql_and_iso_forms() {
        let sql = metric_time("2026-10-12 20:40:53.538").unwrap();
        let iso = metric_time("2026-10-12T20:40:53.538Z").unwrap();
        assert_eq!(sql, iso);
        assert_eq!(
            metric_time("2026-10-12 20:40:53").unwrap(),
            sql / 1000 * 1000
        );
        // Zoned input is respected.
        assert_eq!(metric_time("2026-10-12T22:40:53.538+02:00").unwrap(), sql);
        assert!(metric_time("not a time").is_none());
    }

    #[test]
    fn sample_time_is_trusted_only_when_sane() {
        let now = metric_time("2026-10-12 20:40:53.538").unwrap();

        assert!(resolve_sample_time(None, now).is_none());
        assert!(resolve_sample_time(Some(&json!(12)), now).is_none());
        assert!(resolve_sample_time(Some(&json!("")), now).is_none());
        // 40s ago is a fine backfill.
        let backfill = sql_time_millis(now - 40_000);
        assert_eq!(
            resolve_sample_time(Some(&json!(backfill)), now),
            Some(backfill.clone())
        );
        // Future beyond clock skew is rejected.
        assert!(
            resolve_sample_time(Some(&json!(sql_time_millis(now + 10 * 60_000))), now).is_none()
        );
        // Older than retention could never be archived.
        assert!(
            resolve_sample_time(
                Some(&json!(sql_time_millis(now - 40 * 24 * 3_600_000))),
                now
            )
            .is_none()
        );
    }

    #[test]
    fn validation_rejects_non_objects_and_oversize() {
        assert!(validate_metrics(&json!({"a": 1})).is_ok());
        assert!(validate_metrics(&json!("nope")).is_err());
        assert!(validate_metrics(&json!([1, 2])).is_err());

        let big = "x".repeat(METRICS_MAX_BYTES);
        assert!(validate_metrics(&json!({ "blob": big })).is_err());
    }
}
