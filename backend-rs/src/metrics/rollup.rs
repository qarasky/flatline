//! Hourly rollups: the long tier of metrics history (`metrics-rollup.js`).
//!
//! Raw samples live 30 days at ~30s resolution. This job folds every
//! complete hour into one row per monitor — min, max, average per metric,
//! plus the number of raw readings — and keeps those for two years.
//!
//! Design notes (same as the Node job):
//! - Coverage is decided per monitor and hour by comparing the raw sample
//!   count with the stored bucket's sample count. Durable buckets are keyed
//!   by (monitor_id, time), so a bucket is (re)built exactly when raw
//!   evidence exists that it does not represent yet — no hour is ever
//!   considered covered on another monitor's behalf, and a crash
//!   mid-backfill leaves a gap the next run simply fills. Buckets are
//!   upserted on (monitor_id, time), so re-runs are idempotent.
//! - Late samples also leave a dirty-hour marker at ingest. Buffered agents
//!   can deliver a sample more than two hours after it was taken; the marker
//!   forces the hour to be re-folded and is cleared once a run looked at it.
//!   Markers for hours whose raw rows were pruned are dropped without
//!   touching the bucket.
//! - Work is chunked by elapsed time (a gap splits a chunk rather than
//!   stretching it) and each chunk is folded page by page, so no single
//!   query materializes a long stretch of raw payloads; a first run
//!   backfills the full raw retention without loading everything at once.
//! - Only complete hours roll up: the current hour is still accumulating.
//! - The rollup runs hourly and the raw prune daily, so the repair pass
//!   always has the raw evidence it needs before the prune removes it.

use std::collections::{HashMap, HashSet};

use sqlx::SqlitePool;

use crate::metrics::history;
use crate::metrics::{metric_time, sql_time_millis};

/// How long hourly rollups are kept. Raw stays at 30 days.
pub const HOURLY_RETENTION_DAYS: i64 = 730;
/// Widest span of elapsed time folded in one pass.
///
/// It bounds elapsed time, not the number of missing hours: a single old
/// gap beside recent hours used to stretch one chunk across hundreds of
/// hours and pull every payload in between. A gap now splits the chunk.
pub const CHUNK_HOURS: usize = 6;
/// Raw rows fetched per query, bounding memory and lock time per page.
pub const ROWS_PER_PAGE: i64 = 5000;
/// Hours of raw evidence the repair sweep verifies per run.
///
/// The sweep exists for damage the dirty markers cannot see (a pre-existing
/// gap, a marker write that failed). It walks the raw window in windows this
/// wide, one per run, so a full sweep costs about a day of runs instead of
/// scanning the whole window on every run.
pub const REPAIR_WINDOW_HOURS: i64 = 24;
/// The newest complete hours are re-verified every run, wherever the sweep is.
pub const REPAIR_OVERLAP_HOURS: i64 = 2;
/// State name of the repair sweep cursor.
const REPAIR_CURSOR: &str = "repair_cursor";

#[derive(Debug, Default)]
pub struct RollupResult {
    pub rolled_up: usize,
    pub chunks: usize,
    /// Expired hourly buckets deleted.
    pub pruned: u64,
    /// Expired raw (monitor, hour) pairs deleted after being proven folded.
    pub pruned_raw: u64,
    /// Expired raw pairs kept because no bucket covers them yet: the next
    /// run folds them first.
    pub skipped_raw: u64,
    /// Hours of raw evidence whose counts were compared with their buckets.
    /// Bounded per run except on the first run after the state exists, which
    /// reconciles the whole retained window once.
    pub verified_hours: i64,
}

/// Floor epoch millis to the start of its UTC hour.
pub fn hour_start(ms: i64) -> i64 {
    ms.div_euclid(3_600_000) * 3_600_000
}

/// The lowest SQL spelling of an hour start.
///
/// Stored times are strings, and legacy/imported rows can carry whole
/// seconds instead of milliseconds. Compared as strings, the second-precision
/// spelling of an hour start sorts below its millisecond spelling, so a range
/// that must include an hour's first row whatever its precision starts from
/// the second-precision form. Grouping is by hour, so including such a row
/// can never put it in the wrong bucket — and leaving it out would leave it
/// unfolded, which the verified prune would then refuse to delete forever.
fn sql_time_lower_bound(ms: i64) -> String {
    let full = sql_time_millis(ms);
    full[..full.len().min(19)].to_string()
}

/// The oldest hour that still has complete raw evidence.
///
/// Raw pruning removes whole hours (see [`prune_raw`]), so every hour at or
/// after this boundary is untouched and therefore complete; only such hours
/// may be (re)folded from raw rows. The boundary hour itself is the one an
/// unaligned prune could have split before that rule existed, so an existing
/// bucket there is kept rather than rebuilt from the survivors.
pub fn raw_boundary_hour(now_ms: i64) -> i64 {
    hour_start(now_ms - crate::metrics::METRICS_RETENTION_DAYS * 24 * 3_600_000)
}

/// One (monitor, hour) accumulator.
///
/// Min/max/sum/count per metric instead of every reading: pages of one hour
/// are folded together as they arrive, so a chunk never holds the raw
/// samples in memory.
struct Bucket {
    monitor_id: i64,
    hour: i64,
    samples: i64,
    min: [Option<f64>; 4],
    max: [Option<f64>; 4],
    sum: [f64; 4],
    count: [i64; 4],
}

impl Bucket {
    fn new(monitor_id: i64, hour: i64) -> Self {
        Self {
            monitor_id,
            hour,
            samples: 0,
            min: [None; 4],
            max: [None; 4],
            sum: [0.0; 4],
            count: [0; 4],
        }
    }

    /// Fold one reading (cpu/ram/gpu/vram, `None` = absent) into the bucket.
    fn add(&mut self, reading: &history::Readings) {
        self.samples += 1;
        let values = [reading.cpu, reading.ram, reading.gpu, reading.vram];
        for (slot, value) in values.into_iter().enumerate() {
            let Some(value) = value else { continue };
            self.sum[slot] += value;
            self.count[slot] += 1;
            self.min[slot] = Some(self.min[slot].map_or(value, |current| current.min(value)));
            self.max[slot] = Some(self.max[slot].map_or(value, |current| current.max(value)));
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
            if self.count[slot] == 0 {
                continue;
            }
            *min = self.min[slot];
            *max = self.max[slot];
            *avg = Some(self.sum[slot] / self.count[slot] as f64);
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


/// The stored repair cursor, or `None` when the sweep has never run.
async fn read_repair_cursor(pool: &SqlitePool) -> sqlx::Result<Option<i64>> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM metrics_rollup_state WHERE name = ?")
            .bind(REPAIR_CURSOR)
            .fetch_optional(pool)
            .await?;
    Ok(value
        .as_deref()
        .and_then(metric_time)
        .map(hour_start))
}

/// Persist the repair cursor.
async fn write_repair_cursor(pool: &SqlitePool, hour: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO metrics_rollup_state (name, value) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value",
    )
    .bind(REPAIR_CURSOR)
    .bind(sql_time_millis(hour))
    .execute(pool)
    .await?;
    Ok(())
}

/// Forget the repair sweep cursor.
///
/// The next run then reconciles the whole retained window once, like the
/// first run after this state was introduced — the escape hatch when
/// coverage is suspected to be wrong (tests, or an operator after restoring
/// a database).
pub async fn reset_rollup_state(pool: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM metrics_rollup_state WHERE name = ?")
        .bind(REPAIR_CURSOR)
        .execute(pool)
        .await?;
    Ok(())
}

/// The next repair window: a bounded span of complete hours, walking
/// backwards from the newest hour and cycling over the raw window.
///
/// The first run after this state exists (a fresh database, or the upgrade)
/// reconciles the whole retained window once — bounded by the 30-day raw
/// retention, not by how long the process has been up — so a fresh import
/// does not wait out a full sweep cycle to get its long tier.
///
/// `cycle_floor` is the oldest hour with any raw evidence: hours below the
/// retention boundary may hold survivors whose bucket is missing, and those
/// must stay reachable.
async fn next_repair_window(
    pool: &SqlitePool,
    cycle_floor: i64,
    newest_hour: i64,
) -> sqlx::Result<(i64, i64)> {
    let Some(cursor) = read_repair_cursor(pool).await? else {
        write_repair_cursor(pool, newest_hour).await?;
        return Ok((cycle_floor, newest_hour));
    };

    let start = cycle_floor.max(cursor - REPAIR_WINDOW_HOURS * 3_600_000);
    let end = start.max(newest_hour.min(cursor));
    let next = if start <= cycle_floor {
        newest_hour
    } else {
        start
    };
    write_repair_cursor(pool, next).await?;
    Ok((start, end))
}

/// Grouped raw counts per (monitor, hour) inside one window.
async fn counts_in(
    pool: &SqlitePool,
    start: i64,
    end: i64,
) -> sqlx::Result<Vec<(i64, String, i64)>> {
    sqlx::query_as(
        "SELECT monitor_id, substr(replace(time, 'T', ' '), 1, 13) || ':00:00' AS hour, COUNT(*)
         FROM metrics_raw WHERE time >= ? AND time < ?
         GROUP BY monitor_id, hour",
    )
    .bind(sql_time_lower_bound(start))
    .bind(sql_time_millis(end))
    .fetch_all(pool)
    .await
}

/// Mark every (monitor, hour) in grouped counts that needs a fold.
///
/// Shared by the repair sweep and the recency overlap: both compare the raw
/// row count of an hour with its bucket, with the same guards as the dirty
/// path (never downgrade a richer bucket, leave the boundary hour alone).
fn mark_due_from_counts(
    rows: &[(i64, String, i64)],
    boundary_hour: i64,
    stored: &HashMap<(i64, i64), i64>,
    raw_counts: &mut HashMap<(i64, i64), i64>,
    needs: &mut HashSet<(i64, i64)>,
) {
    for (monitor_id, hour, samples) in rows {
        let Some(hour) = metric_time(hour).map(hour_start) else {
            continue;
        };
        let key = (*monitor_id, hour);
        raw_counts.insert(key, *samples);
        let stored_samples = stored.get(&key).copied().unwrap_or(-1);
        if hour <= boundary_hour && stored_samples >= 0 {
            // The boundary hour is the one an unaligned prune could have
            // split: a rebuild would replace a complete aggregate with the
            // survivors. A *missing* bucket is different — the survivors are
            // the only record left, so they are folded.
            continue;
        }
        if stored_samples > *samples {
            // The bucket covers more samples than the raw table still holds:
            // its evidence was pruned away. A rebuild could only lose history.
            continue;
        }
        if stored_samples < *samples {
            needs.insert(key);
        }
    }
}

/// One raw row folded into the running accumulators.
fn accumulate_row(
    buckets: &mut HashMap<(i64, i64), Bucket>,
    monitor_id: i64,
    time: &str,
    payload: &str,
) {
    let Some(ms) = metric_time(time) else {
        return;
    };
    let hour = hour_start(ms);
    let bucket = buckets
        .entry((monitor_id, hour))
        .or_insert_with(|| Bucket::new(monitor_id, hour));
    bucket.add(&history::readings_from_payload(payload));
}

/// Fold one chunk of raw rows into per-monitor, per-hour aggregates.
#[cfg(test)]
fn aggregate_chunk(rows: &[(i64, String, String)]) -> HashMap<(i64, i64), Bucket> {
    let mut buckets: HashMap<(i64, i64), Bucket> = HashMap::new();
    for (monitor_id, time, payload) in rows {
        accumulate_row(&mut buckets, *monitor_id, time, payload);
    }
    buckets
}

/// Roll raw samples up into complete hours, then prune expired rollups.
///
/// Idempotent: buckets are upserted and coverage is judged from the data, so
/// a crash or restart mid-backfill resumes rather than duplicating or losing
/// hours.
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

    // Raw rows are stamped inside their hour, so the window ends at the next
    // hour start; bucket keys are stamped at the hour start itself.
    let from = sql_time_lower_bound(oldest_hour);
    let to_exclusive = sql_time_millis(last_complete_hour + 3_600_000);

    // Stored buckets inside the raw window: coverage is judged per monitor
    // and hour, because the durable bucket key is (monitor_id, time).
    let stored_rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT monitor_id, time, samples FROM metrics_hourly WHERE time >= ? AND time < ?",
    )
    .bind(&from)
    .bind(&to_exclusive)
    .fetch_all(pool)
    .await?;
    let stored: HashMap<(i64, i64), i64> = stored_rows
        .iter()
        .filter_map(|(monitor_id, time, samples)| {
            metric_time(time).map(|ms| ((*monitor_id, hour_start(ms)), *samples))
        })
        .collect();

    let boundary_hour = raw_boundary_hour(now_ms);
    let mut raw_counts: HashMap<(i64, i64), i64> = HashMap::new();
    let mut needs: HashSet<(i64, i64)> = HashSet::new();

    // Dirty markers first: one indexed count per marked pair, so a late
    // sample is folded without looking at any other hour. A marker whose raw
    // rows were pruned, or whose hour predates the boundary, is dropped at
    // the end of the run without touching its bucket.
    let dirty: Vec<(i64, String)> =
        sqlx::query_as("SELECT monitor_id, hour FROM metrics_rollup_dirty WHERE hour >= ? AND hour <= ?")
            .bind(&from)
            .bind(sql_time_millis(last_complete_hour))
            .fetch_all(pool)
            .await?;
    for (monitor_id, hour) in &dirty {
        let Some(hour) = metric_time(hour).map(hour_start) else {
            continue;
        };
        if hour <= boundary_hour {
            // The boundary hour may hold partial raw evidence from an
            // unaligned prune; never rebuild it over an existing bucket.
            continue;
        }
        let key = (*monitor_id, hour);
        let raw_samples: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ? AND time >= ? AND time < ?",
        )
        .bind(monitor_id)
        .bind(sql_time_lower_bound(hour))
        .bind(sql_time_millis(hour + 3_600_000))
        .fetch_one(pool)
        .await?;
        raw_counts.insert(key, raw_samples);
        // Never rebuild from a partial raw set: a dirty hour whose bucket
        // already covers more samples than the raw table holds keeps it.
        if raw_samples > 0 && stored.get(&key).copied().unwrap_or(-1) <= raw_samples {
            needs.insert(key);
        }
    }

    // Repair sweep: one bounded window of older hours per run, plus the
    // newest complete hours every run, so damage without a dirty marker is
    // still found within a cycle.
    let cycle_floor = oldest_hour.min(boundary_hour);
    let newest_hour = last_complete_hour + 3_600_000;
    let (sweep_start, sweep_end) = next_repair_window(pool, cycle_floor, newest_hour).await?;
    let sweep_rows = counts_in(pool, sweep_start, sweep_end).await?;
    mark_due_from_counts(
        &sweep_rows,
        boundary_hour,
        &stored,
        &mut raw_counts,
        &mut needs,
    );
    let mut verified_hours = (sweep_end - sweep_start) / 3_600_000;

    let overlap_start =
        boundary_hour.max(last_complete_hour - (REPAIR_OVERLAP_HOURS - 1) * 3_600_000);
    let overlap_inside_sweep = overlap_start >= sweep_start && overlap_start < sweep_end;
    if !overlap_inside_sweep {
        let overlap_rows = counts_in(pool, overlap_start, newest_hour).await?;
        mark_due_from_counts(
            &overlap_rows,
            boundary_hour,
            &stored,
            &mut raw_counts,
            &mut needs,
        );
        verified_hours += REPAIR_OVERLAP_HOURS;
    }

    // Process the due pairs in time order. Chunks are bounded in elapsed
    // time (a gap splits them) and each chunk is folded page by page, so no
    // single query materializes a long stretch of raw payloads.
    let mut hours: Vec<i64> = needs.iter().map(|(_, hour)| *hour).collect::<HashSet<_>>().into_iter().collect();
    hours.sort_unstable();

    let mut result = RollupResult::default();
    let mut index = 0;
    while index < hours.len() {
        let window_start = hours[index];
        let mut end = index;
        while end + 1 < hours.len()
            && hours[end + 1] - window_start < CHUNK_HOURS as i64 * 3_600_000
        {
            end += 1;
        }
        let window_end = hours[end] + 3_600_000;
        result.chunks += 1;
        index = end + 1;

        // Keyset pagination on (time, id): each page is bounded, and the
        // accumulators hold one entry per (monitor, hour), never the rows.
        let mut buckets: HashMap<(i64, i64), Bucket> = HashMap::new();
        let mut cursor: Option<(String, i64)> = None;
        loop {
            let rows: Vec<(i64, i64, String, String)> = match &cursor {
                Some((time, id)) => {
                    sqlx::query_as(
                        "SELECT id, monitor_id, time, payload FROM metrics_raw
                         WHERE time >= ? AND time < ? AND (time > ? OR (time = ? AND id > ?))
                         ORDER BY time, id LIMIT ?",
                    )
                    .bind(sql_time_lower_bound(window_start))
                    .bind(sql_time_millis(window_end))
                    .bind(time)
                    .bind(time)
                    .bind(id)
                    .bind(ROWS_PER_PAGE)
                    .fetch_all(pool)
                    .await?
                }
                None => {
                    sqlx::query_as(
                        "SELECT id, monitor_id, time, payload FROM metrics_raw
                         WHERE time >= ? AND time < ?
                         ORDER BY time, id LIMIT ?",
                    )
                    .bind(sql_time_lower_bound(window_start))
                    .bind(sql_time_millis(window_end))
                    .bind(ROWS_PER_PAGE)
                    .fetch_all(pool)
                    .await?
                }
            };

            let page_len = rows.len();
            for (_, monitor_id, time, payload) in &rows {
                accumulate_row(&mut buckets, *monitor_id, time, payload);
            }
            if page_len < ROWS_PER_PAGE as usize {
                break;
            }
            let Some((id, _, time, _)) = rows.last() else {
                break;
            };
            cursor = Some((time.clone(), *id));
        }

        for bucket in buckets.into_values() {
            let key = (bucket.monitor_id, bucket.hour);
            if !needs.remove(&key) {
                continue;
            }
            store_bucket(pool, &bucket.row()).await?;
            result.rolled_up += 1;
        }
    }

    // Every marker inside the processed range has been considered: re-folded
    // or dropped as evidence-free. A marker written while this run was
    // working is safe either way: if its raw row landed before the count
    // query it was folded, and if it landed after, the next run's count
    // comparison sees the new row.
    sqlx::query("DELETE FROM metrics_rollup_dirty WHERE hour <= ?")
        .bind(sql_time_millis(last_complete_hour))
        .execute(pool)
        .await?;

    // Fold first, then prune what is proven folded: verification is part of
    // the maintenance run itself, not a separately scheduled job that merely
    // assumes the fold succeeded.
    let raw = prune_raw(pool, now_ms, crate::metrics::METRICS_RETENTION_DAYS).await?;
    result.pruned_raw = raw.deleted;
    result.skipped_raw = raw.skipped;
    result.verified_hours = verified_hours;

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

/// Outcome of a verified raw prune.
#[derive(Debug, Default, Clone, Copy)]
pub struct RawPruneOutcome {
    /// Expired (monitor, hour) pairs deleted.
    pub deleted: u64,
    /// Expired pairs kept because no bucket covers them yet.
    pub skipped: u64,
}

/// Delete raw samples older than the retention window, verified pair by pair.
///
/// A pair — one (monitor, hour) — is deleted only when an hourly bucket covers
/// every remaining raw row of it. Rows whose hour is not (fully) folded stay
/// in place: the next run's repair folds them, and only then are they pruned.
/// That is the actual repair-before-prune guarantee, instead of the old
/// assumption that the daily schedule always ran after a successful fold.
///
/// Called from [`rollup_metrics`], after the fold, so a fold failure or a
/// pending repair can never put deletion ahead of repair. Whole hours only:
/// a cutoff inside an hour would leave partial evidence behind, and a later
/// late sample would re-fold that hour from the survivors.
pub async fn prune_raw(
    pool: &SqlitePool,
    now_ms: i64,
    days: i64,
) -> sqlx::Result<RawPruneOutcome> {
    let cutoff_hour = hour_start(now_ms - days * 24 * 3_600_000);

    // Pairs that have aged out, with their remaining row counts.
    let expired: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT monitor_id, substr(replace(time, 'T', ' '), 1, 13) || ':00:00' AS hour, COUNT(*)
         FROM metrics_raw WHERE time < ?
         GROUP BY monitor_id, hour",
    )
    .bind(sql_time_millis(cutoff_hour))
    .fetch_all(pool)
    .await?;
    if expired.is_empty() {
        return Ok(RawPruneOutcome::default());
    }

    // Coverage: the stored bucket's sample count per pair.
    let oldest = expired
        .iter()
        .filter_map(|(_, hour, _)| metric_time(hour).map(hour_start))
        .min()
        .unwrap_or(cutoff_hour);
    let covered_rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT monitor_id, time, samples FROM metrics_hourly WHERE time >= ? AND time < ?",
    )
    .bind(sql_time_lower_bound(oldest))
    .bind(sql_time_millis(cutoff_hour))
    .fetch_all(pool)
    .await?;
    let covered: HashMap<(i64, i64), i64> = covered_rows
        .iter()
        .filter_map(|(monitor_id, time, samples)| {
            metric_time(time).map(|ms| ((*monitor_id, hour_start(ms)), *samples))
        })
        .collect();

    let mut outcome = RawPruneOutcome::default();
    for (monitor_id, hour, samples) in &expired {
        let Some(hour) = metric_time(hour).map(hour_start) else {
            continue;
        };
        let stored_samples = covered.get(&(*monitor_id, hour)).copied();
        if stored_samples.is_none_or(|stored| stored < *samples) {
            // Not folded (yet): keep the evidence and let the repair pass
            // fold it first. Pruning it now would lose those readings.
            outcome.skipped += 1;
            continue;
        }
        sqlx::query(
            "DELETE FROM metrics_raw WHERE monitor_id = ? AND time >= ? AND time < ? AND time < ?",
        )
        .bind(monitor_id)
        .bind(sql_time_lower_bound(hour))
        .bind(sql_time_millis(hour + 3_600_000))
        .bind(sql_time_millis(cutoff_hour))
        .execute(pool)
        .await?;
        outcome.deleted += 1;
    }

    if outcome.skipped > 0 {
        tracing::warn!(
            "rollup: kept {} expired raw hour(s) that are not fully folded yet",
            outcome.skipped
        );
    }
    Ok(outcome)
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

        // A re-run has no new evidence: nothing re-folds and no bucket is
        // duplicated.
        let second = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(second.rolled_up, 0);
        assert_eq!(second.chunks, 0);
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
    async fn rollup_covers_every_monitor_and_repairs_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let mut monitor_ids = Vec::new();
        for name in ["a", "b", "c"] {
            let (id,): (i64,) = sqlx::query_as(
                "INSERT INTO monitors (name, type) VALUES (?, 'push') RETURNING id",
            )
            .bind(name)
            .fetch_one(&pool)
            .await
            .unwrap();
            monitor_ids.push(id);
        }

        let now = crate::metrics::metric_time("2026-10-10 12:30:00").unwrap();
        let hour = |offset: i64| hour_start(now) - 4 * 3_600_000 + offset * 3_600_000;
        let insert = |monitor_id: i64, ms: i64, cpu: f64| {
            let time = sql_time_millis(ms);
            let payload = json!({ "cpu": { "percent": cpu }, "mem": { "percent": 50.0 } }).to_string();
            let pool = pool.clone();
            async move {
                sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                    .bind(monitor_id)
                    .bind(time)
                    .bind(payload)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        };

        // Three monitors in the same old window: 08:05 and 11:05.
        for monitor_id in &monitor_ids {
            insert(*monitor_id, hour(0) + 5 * 60_000, 10.0 + *monitor_id as f64).await;
            insert(*monitor_id, hour(3) + 5 * 60_000, 20.0 + *monitor_id as f64).await;
        }

        let first = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(first.rolled_up, 6, "two hours for each of three monitors");
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_hourly")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 6);

        // No new evidence: nothing re-folds.
        let idle = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(idle.rolled_up, 0);
        assert_eq!(idle.chunks, 0);

        // A late backfill into an already-folded hour is re-folded. It is
        // inserted without an ingest marker (as if the marker write had
        // failed): the repair sweep's count comparison catches it, and the
        // sweep is bounded per run, so force the full reconciliation the
        // first run after the upgrade does.
        reset_rollup_state(&pool).await.unwrap();
        insert(monitor_ids[0], hour(0) + 50 * 60_000, 90.0).await;
        let late = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(late.rolled_up, 1, "only the affected pair re-rolls");
        let row: (i64, f64, f64) = sqlx::query_as(
            "SELECT samples, cpu_avg, cpu_max FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_ids[0])
        .bind(sql_time_millis(hour(0)))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 2);
        assert_eq!(row.1, (10.0 + monitor_ids[0] as f64 + 90.0) / 2.0);
        assert_eq!(row.2, 90.0);

        // A missing bucket is rebuilt from the raw evidence (again, by the
        // reconciliation the sweep performs once per cycle).
        reset_rollup_state(&pool).await.unwrap();
        sqlx::query("DELETE FROM metrics_hourly WHERE monitor_id = ? AND time = ?")
            .bind(monitor_ids[1])
            .bind(sql_time_millis(hour(3)))
            .execute(&pool)
            .await
            .unwrap();
        let repaired = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(repaired.rolled_up, 1, "the deleted bucket is rebuilt");
        let samples: i64 = sqlx::query_scalar(
            "SELECT samples FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_ids[1])
        .bind(sql_time_millis(hour(3)))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(samples, 1);

        // A dirty marker forces a re-fold even when the counts agree, and is
        // consumed by the run.
        sqlx::query("INSERT INTO metrics_rollup_dirty (monitor_id, hour) VALUES (?, ?)")
            .bind(monitor_ids[2])
            .bind(sql_time_millis(hour(0)))
            .execute(&pool)
            .await
            .unwrap();
        let marked = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(marked.rolled_up, 1);
        let dirty_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_rollup_dirty")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty_left, 0);

        // A marker whose raw rows are gone is dropped without touching the
        // buckets it names.
        sqlx::query("INSERT INTO metrics_rollup_dirty (monitor_id, hour) VALUES (?, ?)")
            .bind(monitor_ids[0])
            .bind(sql_time_millis(hour(2)))
            .execute(&pool)
            .await
            .unwrap();
        let stale = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(stale.rolled_up, 0);
        let dirty_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_rollup_dirty")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty_left, 0);
        let buckets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_hourly")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(buckets, 6, "existing buckets survive");
    }

    #[tokio::test]
    async fn rollup_bounds_elapsed_windows_and_pages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        let now = crate::metrics::metric_time("2026-10-10 12:30:00").unwrap();
        let last_complete = hour_start(now) - 3_600_000;

        let insert = |pool: &SqlitePool, monitor_id: i64, ms: i64, cpu: f64| {
            let time = sql_time_millis(ms);
            let payload = json!({ "cpu": { "percent": cpu } }).to_string();
            let pool = pool.clone();
            async move {
                sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                    .bind(monitor_id)
                    .bind(time)
                    .bind(payload)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        };

        // One hour 20 days back and one recent hour: the old coverage check
        // would have produced a single chunk spanning the whole gap.
        insert(&pool, monitor_id, last_complete - 20 * 24 * 3_600_000 + 600_000, 10.0).await;
        insert(&pool, monitor_id, last_complete + 600_000, 20.0).await;

        let result = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(result.rolled_up, 2);
        assert_eq!(
            result.chunks, 2,
            "the 20-day gap must split the two hours into separate chunks"
        );

        // An hour holding more rows than one page: every page must be folded.
        let wide = last_complete - 3_600_000;
        let total = ROWS_PER_PAGE + 1;
        for i in 0..total {
            insert(&pool, monitor_id, wide + 1000 + i * 100, (i % 100) as f64).await;
        }

        let result = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(result.rolled_up, 1);
        let (samples, min, max): (i64, f64, f64) = sqlx::query_as(
            "SELECT samples, cpu_min, cpu_max FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_id)
        .bind(sql_time_millis(wide))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(samples, total, "every page must be folded");
        assert_eq!(min, 0.0);
        assert_eq!(max, 99.0);
    }

    #[tokio::test]
    async fn maintenance_run_folds_then_prunes_whole_hours() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        // One row inside the hour the cutoff falls in, one three hours older.
        let boundary = raw_boundary_hour(chrono::Utc::now().timestamp_millis());
        for (offset, cpu) in [(-3 * 3_600_000 + 60_000_i64, 10.0), (60_000, 20.0)] {
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(sql_time_millis(boundary + offset))
                .bind(json!({ "cpu": { "percent": cpu } }).to_string())
                .execute(&pool)
                .await
                .unwrap();
        }

        // One maintenance run: fold both hours, then prune the aged-out one.
        let result = rollup_metrics(&pool, chrono::Utc::now().timestamp_millis())
            .await
            .unwrap();
        assert_eq!(result.rolled_up, 2, "both hours fold");
        assert_eq!(result.pruned_raw, 1, "the aged-out hour is pruned once folded");
        assert_eq!(result.skipped_raw, 0);

        let left: Vec<String> = sqlx::query_scalar("SELECT time FROM metrics_raw ORDER BY time")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(left.len(), 1, "the boundary hour survives intact");
        assert!(
            left.iter()
                .all(|time| metric_time(time).unwrap() >= boundary),
            "no row from inside the boundary hour was deleted"
        );
    }

    #[tokio::test]
    async fn second_precision_rows_are_folded_and_pruned() {
        // Legacy/imported rows can carry whole seconds. The second-precision
        // spelling of an hour start sorts below the millisecond one, so a
        // range that starts from the milliseconds form would skip the hour's
        // first row: it would never fold, and the verified prune would then
        // keep it forever.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        let now = chrono::Utc::now().timestamp_millis();
        let hour = raw_boundary_hour(now) - 5 * 3_600_000;
        let second_precision = sql_time_millis(hour)[..19].to_string();
        sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
            .bind(monitor_id)
            .bind(&second_precision)
            .bind(json!({ "cpu": { "percent": 42.0 } }).to_string())
            .execute(&pool)
            .await
            .unwrap();

        let result = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(result.rolled_up, 1, "the whole-second row is folded");
        assert_eq!(result.pruned_raw, 1, "and pruned once folded");
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_raw")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn late_backfill_never_downgrades_a_complete_bucket() {
        // The follow-up finding: an unaligned prune removed part of the
        // boundary hour's raw rows, then an accepted late sample marked the
        // hour dirty and the rebuild replaced the complete bucket with a
        // partial aggregate (peak 100 -> 0, mean 50 -> 0).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        let now = chrono::Utc::now().timestamp_millis();
        let hour = raw_boundary_hour(now);
        let payload = |cpu: f64| json!({ "cpu": { "percent": cpu } }).to_string();
        let insert = |time: i64, payload: String| {
            let pool = pool.clone();
            async move {
                sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                    .bind(monitor_id)
                    .bind(sql_time_millis(time))
                    .bind(payload)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        };

        insert(hour + 60_000, payload(100.0)).await;
        insert(hour + 30 * 60_000, payload(0.0)).await;
        rollup_metrics(&pool, now).await.unwrap();
        let (samples, max, avg): (i64, f64, f64) = sqlx::query_as(
            "SELECT samples, cpu_max, cpu_avg FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_id)
        .bind(sql_time_millis(hour))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((samples, max, avg), (2, 100.0, 50.0));

        // A legacy unaligned prune leaves one row; a late sample arrives.
        sqlx::query("DELETE FROM metrics_raw WHERE monitor_id = ? AND time = ?")
            .bind(monitor_id)
            .bind(sql_time_millis(hour + 60_000))
            .execute(&pool)
            .await
            .unwrap();
        insert(hour + 45 * 60_000, payload(0.0)).await;
        sqlx::query("INSERT INTO metrics_rollup_dirty (monitor_id, hour) VALUES (?, ?)")
            .bind(monitor_id)
            .bind(sql_time_millis(hour))
            .execute(&pool)
            .await
            .unwrap();

        rollup_metrics(&pool, now).await.unwrap();
        let (samples, max, avg): (i64, f64, f64) = sqlx::query_as(
            "SELECT samples, cpu_max, cpu_avg FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_id)
        .bind(sql_time_millis(hour))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            (samples, max, avg),
            (2, 100.0, 50.0),
            "the complete bucket must not be replaced by a partial rebuild"
        );
        let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_rollup_dirty")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dirty, 0, "marker consumed");
    }

    #[tokio::test]
    async fn work_selection_is_bounded_per_run() {
        // The follow-up finding: every run grouped the whole retained raw
        // window (about 550-750ms at ten hosts) to find the few hours needing
        // work. Normal runs process the dirty hours plus a bounded window;
        // the whole-window comparison happens once.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        let now = crate::metrics::metric_time("2026-10-10 12:30:00").unwrap();
        sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, '{}')")
            .bind(monitor_id)
            .bind(sql_time_millis(now - 3_600_000 + 60_000))
            .execute(&pool)
            .await
            .unwrap();

        reset_rollup_state(&pool).await.unwrap();
        let full = rollup_metrics(&pool, now).await.unwrap();
        assert!(
            full.verified_hours >= 24 * 29,
            "the first run reconciles the window, got {}h",
            full.verified_hours
        );

        let bounded = rollup_metrics(&pool, now).await.unwrap();
        assert!(
            bounded.verified_hours <= REPAIR_WINDOW_HOURS + REPAIR_OVERLAP_HOURS,
            "later runs verify one window plus the overlap, got {}h",
            bounded.verified_hours
        );
    }

    #[tokio::test]
    async fn dirty_hour_folds_without_the_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        let now = crate::metrics::metric_time("2026-10-10 12:30:00").unwrap();
        let hour = hour_start(now) - 6 * 3_600_000;
        for (offset, cpu) in [(60_000_i64, 11.0), (25 * 60_000, 12.0)] {
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(sql_time_millis(hour + offset))
                .bind(json!({ "cpu": { "percent": cpu } }).to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO metrics_rollup_dirty (monitor_id, hour) VALUES (?, ?)")
            .bind(monitor_id)
            .bind(sql_time_millis(hour))
            .execute(&pool)
            .await
            .unwrap();
        // Prime the sweep cursor so this is a normal run, not the one-time
        // reconciliation a first run performs.
        write_repair_cursor(&pool, hour_start(now)).await.unwrap();

        let result = rollup_metrics(&pool, now).await.unwrap();
        assert_eq!(result.rolled_up, 1, "the marked pair folds");
        assert!(
            result.verified_hours <= REPAIR_WINDOW_HOURS + REPAIR_OVERLAP_HOURS,
            "without a window-wide scan"
        );
        let samples: i64 = sqlx::query_scalar(
            "SELECT samples FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_id)
        .bind(sql_time_millis(hour))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(samples, 2);
    }

    #[tokio::test]
    async fn missing_bucket_is_repaired_within_a_sweep_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        let now = crate::metrics::metric_time("2026-10-10 12:30:00").unwrap();
        let hour = hour_start(now) - 20 * 24 * 3_600_000;
        sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
            .bind(monitor_id)
            .bind(sql_time_millis(hour + 60_000))
            .bind(json!({ "cpu": { "percent": 33.0 } }).to_string())
            .execute(&pool)
            .await
            .unwrap();

        // A normal run verifies one bounded window, not the whole retention.
        write_repair_cursor(&pool, hour_start(now)).await.unwrap();
        let next = rollup_metrics(&pool, now).await.unwrap();
        assert!(next.verified_hours <= REPAIR_WINDOW_HOURS + REPAIR_OVERLAP_HOURS);
        let buckets = |pool: &SqlitePool| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM metrics_hourly WHERE monitor_id = ?",
                )
                .bind(monitor_id)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        assert_eq!(buckets(&pool).await, 0, "the old hour is not folded yet");

        // Walking the cycle reaches it: 30 days of window, 24 hours per run.
        for _ in 0..31 {
            if buckets(&pool).await > 0 {
                break;
            }
            rollup_metrics(&pool, now).await.unwrap();
        }
        let avg: f64 = sqlx::query_scalar(
            "SELECT cpu_avg FROM metrics_hourly WHERE monitor_id = ? AND time = ?",
        )
        .bind(monitor_id)
        .bind(sql_time_millis(hour))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(avg, 33.0, "the sweep repaired the missing bucket");
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

        let outcome = prune_raw(&pool, chrono::Utc::now().timestamp_millis(), 30)
            .await
            .unwrap();
        assert_eq!(outcome.deleted, 0, "unfolded rows are never deleted");
        assert_eq!(outcome.skipped, 1);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_raw")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 2, "both rows stay until their hours are folded");
    }
}
