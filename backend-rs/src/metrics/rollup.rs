//! Hourly rollups: the long tier of metrics history (`metrics-rollup.js`).
//!
//! Raw samples live 30 days at ~30s resolution. This job folds every
//! complete hour into one row per monitor — min, max, average per metric,
//! plus the number of raw readings — and keeps those for two years.
//!
//! Design notes (same as the Node job):
//! - Coverage is decided by inspecting existing buckets, not a watermark: a
//!   crash mid-backfill leaves a gap the next run simply fills. Buckets are
//!   upserted on (monitor_id, time), so re-runs are idempotent.
//! - Work is chunked by time; a first run backfills the full raw retention
//!   without loading everything at once.
//! - Only complete hours roll up; the last two complete hours are re-rolled
//!   every run so late/backfilled samples land in an already-folded hour.

use std::collections::{HashMap, HashSet};

use sqlx::SqlitePool;

use crate::metrics::history;
use crate::metrics::{metric_time, sql_time_millis};

/// How long hourly rollups are kept. Raw stays at 30 days.
pub const HOURLY_RETENTION_DAYS: i64 = 730;
/// Raw-row window processed per query, bounding memory and lock time.
pub const CHUNK_HOURS: usize = 6;

#[derive(Debug, Default)]
pub struct RollupResult {
    pub rolled_up: usize,
    pub chunks: usize,
    pub pruned: u64,
}

/// Floor epoch millis to the start of its UTC hour.
pub fn hour_start(ms: i64) -> i64 {
    ms.div_euclid(3_600_000) * 3_600_000
}

struct Bucket {
    monitor_id: i64,
    hour: i64,
    samples: i64,
    values: [Vec<f64>; 4],
}

impl Bucket {
    fn new(monitor_id: i64, hour: i64) -> Self {
        Self {
            monitor_id,
            hour,
            samples: 0,
            values: std::array::from_fn(|_| Vec::new()),
        }
    }

    fn row(&self) -> HourlyBucketRow {
        let mut row = HourlyBucketRow {
            monitor_id: self.monitor_id,
            time: sql_time_millis(self.hour),
            samples: self.samples,
            ..Default::default()
        };
        let slots = [
            (&mut row.cpu_min, &mut row.cpu_max, &mut row.cpu_avg),
            (&mut row.ram_min, &mut row.ram_max, &mut row.ram_avg),
            (&mut row.gpu_min, &mut row.gpu_max, &mut row.gpu_avg),
            (&mut row.vram_min, &mut row.vram_max, &mut row.vram_avg),
        ];
        for (slot, (min, max, avg)) in slots.into_iter().enumerate() {
            let values = &self.values[slot];
            if values.is_empty() {
                continue;
            }
            let mut lo = values[0];
            let mut hi = values[0];
            let mut sum = 0.0;
            for value in values {
                if *value < lo {
                    lo = *value;
                }
                if *value > hi {
                    hi = *value;
                }
                sum += *value;
            }
            *min = Some(lo);
            *max = Some(hi);
            *avg = Some(sum / values.len() as f64);
        }
        row
    }
}

#[derive(Debug, Default)]
struct HourlyBucketRow {
    monitor_id: i64,
    time: String,
    cpu_min: Option<f64>,
    cpu_max: Option<f64>,
    cpu_avg: Option<f64>,
    ram_min: Option<f64>,
    ram_max: Option<f64>,
    ram_avg: Option<f64>,
    gpu_min: Option<f64>,
    gpu_max: Option<f64>,
    gpu_avg: Option<f64>,
    vram_min: Option<f64>,
    vram_max: Option<f64>,
    vram_avg: Option<f64>,
    samples: i64,
}

/// Fold one chunk of raw rows into per-monitor, per-hour aggregates.
fn aggregate_chunk(rows: &[(i64, String, String)]) -> HashMap<(i64, i64), Bucket> {
    let mut buckets: HashMap<(i64, i64), Bucket> = HashMap::new();
    for (monitor_id, time, payload) in rows {
        let Some(time) = metric_time(time) else {
            continue;
        };
        let hour = hour_start(time);
        let bucket = buckets
            .entry((*monitor_id, hour))
            .or_insert_with(|| Bucket::new(*monitor_id, hour));
        bucket.samples += 1;

        let reading = history::readings_from_payload(payload);
        let values = [reading.cpu, reading.ram, reading.gpu, reading.vram];
        for (slot, value) in values.into_iter().enumerate() {
            if let Some(value) = value {
                bucket.values[slot].push(value);
            }
        }
    }
    buckets
}

/// Roll raw samples up into complete hours, then prune expired rollups.
///
/// Idempotent: covered hours are skipped, so a crash or restart mid-backfill
/// resumes rather than duplicating or losing hours.
pub async fn rollup_metrics(pool: &SqlitePool, now_ms: i64) -> sqlx::Result<RollupResult> {
    let last_complete_hour = hour_start(now_ms) - 3_600_000;

    // The oldest raw sample defines how far back there is anything to fold.
    let oldest: Option<String> = sqlx::query_scalar("SELECT MIN(time) FROM metrics_raw")
        .fetch_one(pool)
        .await?;
    let oldest_hour = oldest.as_deref().and_then(metric_time).map(hour_start);
    let Some(oldest_hour) = oldest_hour else {
        let pruned = prune_hourly(pool, now_ms).await?;
        return Ok(RollupResult {
            pruned,
            ..Default::default()
        });
    };
    if oldest_hour > last_complete_hour {
        let pruned = prune_hourly(pool, now_ms).await?;
        return Ok(RollupResult {
            pruned,
            ..Default::default()
        });
    }

    // Covered hours: buckets that already exist. The last two complete
    // hours are always re-rolled: buffered agents can deliver late samples
    // into an hour a previous run already folded.
    let covered_rows: Vec<String> = sqlx::query_scalar("SELECT DISTINCT time FROM metrics_hourly")
        .fetch_all(pool)
        .await?;
    let mut covered: HashSet<i64> = covered_rows
        .iter()
        .filter_map(|time| metric_time(time).map(hour_start))
        .collect();
    let overlap: HashSet<i64> = [last_complete_hour, last_complete_hour - 3_600_000]
        .into_iter()
        .collect();

    let mut missing = Vec::new();
    let mut hour = oldest_hour;
    while hour <= last_complete_hour {
        if !covered.contains(&hour) || overlap.contains(&hour) {
            missing.push(hour);
        }
        hour += 3_600_000;
    }

    let mut result = RollupResult::default();
    let mut index = 0;
    while index < missing.len() {
        let window_start = missing[index];
        let end_index = (index + CHUNK_HOURS).min(missing.len()) - 1;
        let window_end = (missing[end_index] + 3_600_000).min(last_complete_hour + 3_600_000);

        let rows: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT monitor_id, time, payload FROM metrics_raw WHERE time >= ? AND time < ?",
        )
        .bind(sql_time_millis(window_start))
        .bind(sql_time_millis(window_end))
        .fetch_all(pool)
        .await?;
        result.chunks += 1;

        for bucket in aggregate_chunk(&rows).into_values() {
            if covered.contains(&bucket.hour) && !overlap.contains(&bucket.hour) {
                continue;
            }
            store_bucket(pool, &bucket.row()).await?;
            covered.insert(bucket.hour);
            result.rolled_up += 1;
        }

        index += CHUNK_HOURS;
    }

    result.pruned = prune_hourly(pool, now_ms).await?;
    Ok(result)
}

/// Upsert one bucket; the unique key makes a re-run harmless.
async fn store_bucket(pool: &SqlitePool, row: &HourlyBucketRow) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO metrics_hourly (
             monitor_id, time,
             cpu_min, cpu_max, cpu_avg,
             ram_min, ram_max, ram_avg,
             gpu_min, gpu_max, gpu_avg,
             vram_min, vram_max, vram_avg,
             samples
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (monitor_id, time) DO UPDATE SET
             cpu_min = excluded.cpu_min, cpu_max = excluded.cpu_max, cpu_avg = excluded.cpu_avg,
             ram_min = excluded.ram_min, ram_max = excluded.ram_max, ram_avg = excluded.ram_avg,
             gpu_min = excluded.gpu_min, gpu_max = excluded.gpu_max, gpu_avg = excluded.gpu_avg,
             vram_min = excluded.vram_min, vram_max = excluded.vram_max, vram_avg = excluded.vram_avg,
             samples = excluded.samples",
    )
    .bind(row.monitor_id)
    .bind(&row.time)
    .bind(row.cpu_min)
    .bind(row.cpu_max)
    .bind(row.cpu_avg)
    .bind(row.ram_min)
    .bind(row.ram_max)
    .bind(row.ram_avg)
    .bind(row.gpu_min)
    .bind(row.gpu_max)
    .bind(row.gpu_avg)
    .bind(row.vram_min)
    .bind(row.vram_max)
    .bind(row.vram_avg)
    .bind(row.samples)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete rollups older than the long-tier retention.
async fn prune_hourly(pool: &SqlitePool, now_ms: i64) -> sqlx::Result<u64> {
    let cutoff = sql_time_millis(now_ms - HOURLY_RETENTION_DAYS * 24 * 3_600_000);
    let result = sqlx::query("DELETE FROM metrics_hourly WHERE time < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Delete raw samples older than the retention window.
pub async fn prune_raw(pool: &SqlitePool, days: i64) -> sqlx::Result<u64> {
    let cutoff = sql_time_millis(chrono::Utc::now().timestamp_millis() - days * 24 * 3_600_000);
    let result = sqlx::query("DELETE FROM metrics_raw WHERE time < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chunk_aggregation_buckets_by_hour_and_monitor() {
        let base = 1_800_000_000_000_i64;
        let stamp = |ms: i64| sql_time_millis(ms);
        let payload =
            |cpu: f64| json!({ "cpu": { "percent": cpu }, "mem": { "percent": 50.0 } }).to_string();

        let rows = vec![
            (1, stamp(base), payload(10.0)),
            (1, stamp(base + 60_000), payload(20.0)),
            (1, stamp(base + 3_600_000), payload(90.0)),
            (2, stamp(base), payload(30.0)),
        ];

        let buckets = aggregate_chunk(&rows);
        assert_eq!(buckets.len(), 3);

        let hour = hour_start(base);
        let bucket = buckets.get(&(1, hour)).unwrap();
        assert_eq!(bucket.samples, 2);
        let row = bucket.row();
        assert_eq!(row.cpu_min, Some(10.0));
        assert_eq!(row.cpu_max, Some(20.0));
        assert_eq!(row.cpu_avg, Some(15.0));
        assert_eq!(row.ram_avg, Some(50.0));

        let next = buckets.get(&(1, hour + 3_600_000)).unwrap();
        assert_eq!(next.row().cpu_avg, Some(90.0));
        assert!(buckets.contains_key(&(2, hour)));
    }

    #[tokio::test]
    async fn rollup_is_idempotent_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        let now = chrono::Utc::now().timestamp_millis();
        let hour = hour_start(now) - 3_600_000; // the last complete hour
        let stamp = |offset: i64| sql_time_millis(hour + offset);
        let payload =
            |cpu: f64| json!({ "cpu": { "percent": cpu }, "mem": { "percent": 40.0 } }).to_string();

        for (offset, cpu) in [(0_i64, 10.0), (60_000, 30.0), (120_000, 20.0)] {
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(stamp(offset))
                .bind(payload(cpu))
                .execute(&pool)
                .await
                .unwrap();
        }

        let first = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(first.rolled_up, 1);
        assert_eq!(first.chunks, 1);

        let row: (Option<f64>, Option<f64>, Option<f64>, i64) = sqlx::query_as(
            "SELECT cpu_min, cpu_max, cpu_avg, samples FROM metrics_hourly
             WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_id)
        .bind(sql_time_millis(hour))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, Some(10.0));
        assert_eq!(row.1, Some(30.0));
        assert_eq!(row.2, Some(20.0));
        assert_eq!(row.3, 3);

        // A re-run re-rolls only the overlap hours and upserts the same
        // bucket rather than duplicating it.
        let second = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(second.rolled_up, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_hourly")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        // Expired rollups are pruned.
        sqlx::query("INSERT INTO metrics_hourly (monitor_id, time, samples) VALUES (?, ?, 1)")
            .bind(monitor_id)
            .bind(sql_time_millis(
                now - (HOURLY_RETENTION_DAYS + 10) * 24 * 3_600_000,
            ))
            .execute(&pool)
            .await
            .unwrap();
        let third = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(third.pruned, 1);
    }

    #[tokio::test]
    async fn prune_raw_keeps_recent_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        for days_ago in [40_i64, 10] {
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, '{}')")
                .bind(monitor_id)
                .bind(sql_time_millis(
                    chrono::Utc::now().timestamp_millis() - days_ago * 24 * 3_600_000,
                ))
                .execute(&pool)
                .await
                .unwrap();
        }

        let deleted = prune_raw(&pool, 30).await.unwrap();
        assert_eq!(deleted, 1);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_raw")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 1);
    }
}
