//! Metrics history: raw-row extraction, nearest-rank summaries and the
//! hourly long tier (`metrics-history.js`).
//!
//! Raw samples are read with SQL JSON extraction — never by loading the
//! repeated Docker inventories — and the summary buckets them into a
//! bounded series the charts can plot.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::metrics::{iso_millis, metric_time};

pub const MAX_HISTORY_ROWS: usize = 50_000;
/// Metric keys, in the order the stats and series use.
pub const FIELDS: [&str; 4] = ["cpu", "ram", "gpu", "vram"];

/// SQLite expression guarding a possibly-corrupt payload (JSON_VALID keeps
/// one bad row from failing a whole request).
const PAYLOAD: &str = "CASE WHEN json_valid(payload) THEN payload ELSE '{}' END";

/// Clamp a stored reading to a 0-100 percentage, or None when it is absent
/// or nonsense. Charts must never plot a corrupt value as a real load.
pub fn percentage(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    };
    number.filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}

/// Same clamp for an already-decoded number.
pub fn percentage_f64(value: f64) -> Option<f64> {
    value
        .is_finite()
        .then_some(value)
        .filter(|value| (0.0..=100.0).contains(value))
}

/// One raw row with only the scalar readings extracted.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ScalarRow {
    pub time: String,
    pub cpu: Option<f64>,
    pub ram: Option<f64>,
    pub gpu_available: Option<i64>,
    pub gpu: Option<f64>,
    pub vram_used: Option<f64>,
    pub vram_total: Option<f64>,
}

/// Raw samples in a window, newest first, scalar readings only.
pub async fn scalar_rows(
    pool: &SqlitePool,
    monitor_id: i64,
    from: &str,
    to: &str,
    limit: usize,
) -> sqlx::Result<Vec<ScalarRow>> {
    let sql = format!(
        "SELECT time,
             CAST(json_extract({PAYLOAD}, '$.cpu.percent') AS REAL) AS cpu,
             CAST(json_extract({PAYLOAD}, '$.mem.percent') AS REAL) AS ram,
             CASE WHEN json_extract({PAYLOAD}, '$.gpu.available') IN (1, 'true') THEN 1 ELSE 0 END AS gpu_available,
             CAST(COALESCE(json_extract({PAYLOAD}, '$.gpu.gpus[0].util'),
                           json_extract({PAYLOAD}, '$.gpu.util')) AS REAL) AS gpu,
             CAST(COALESCE(json_extract({PAYLOAD}, '$.gpu.gpus[0].memUsed'),
                           json_extract({PAYLOAD}, '$.gpu.memUsed')) AS REAL) AS vram_used,
             CAST(COALESCE(json_extract({PAYLOAD}, '$.gpu.gpus[0].memTotal'),
                           json_extract({PAYLOAD}, '$.gpu.memTotal')) AS REAL) AS vram_total
         FROM metrics_raw
         WHERE monitor_id = ? AND time >= ? AND time <= ?
         ORDER BY time DESC, id DESC LIMIT ?"
    );

    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(monitor_id)
        .bind(from)
        .bind(to)
        .bind(limit as i64)
        .fetch_all(pool)
        .await
}

/// One hourly rollup row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HourlyRow {
    pub time: String,
    pub samples: i64,
    pub cpu_min: Option<f64>,
    pub cpu_max: Option<f64>,
    pub cpu_avg: Option<f64>,
    pub ram_min: Option<f64>,
    pub ram_max: Option<f64>,
    pub ram_avg: Option<f64>,
    pub gpu_min: Option<f64>,
    pub gpu_max: Option<f64>,
    pub gpu_avg: Option<f64>,
    pub vram_min: Option<f64>,
    pub vram_max: Option<f64>,
    pub vram_avg: Option<f64>,
}

/// Hourly rollup rows for a monitor, newest first.
pub async fn hourly_rows(
    pool: &SqlitePool,
    monitor_id: i64,
    from: &str,
    to: &str,
    limit: usize,
) -> sqlx::Result<Vec<HourlyRow>> {
    sqlx::query_as(
        "SELECT time, samples,
                cpu_min, cpu_max, cpu_avg,
                ram_min, ram_max, ram_avg,
                gpu_min, gpu_max, gpu_avg,
                vram_min, vram_max, vram_avg
         FROM metrics_hourly
         WHERE monitor_id = ? AND time >= ? AND time <= ?
         ORDER BY time DESC LIMIT ?",
    )
    .bind(monitor_id)
    .bind(from)
    .bind(to)
    .bind(limit as i64)
    .fetch_all(pool)
    .await
}

/// The four 0-100 readings of one row.
#[derive(Debug, Clone, Copy, Default)]
pub struct Readings {
    pub cpu: Option<f64>,
    pub ram: Option<f64>,
    pub gpu: Option<f64>,
    pub vram: Option<f64>,
}

impl Readings {
    fn is_empty(&self) -> bool {
        self.cpu.is_none() && self.ram.is_none() && self.gpu.is_none() && self.vram.is_none()
    }

    fn as_array(&self) -> [Option<f64>; 4] {
        [self.cpu, self.ram, self.gpu, self.vram]
    }
}

/// Turn one extracted SQL row into readings, applying the GPU availability
/// rule and the VRAM used/total ratio.
pub fn readings(row: &ScalarRow) -> Readings {
    let available = row.gpu_available.unwrap_or(0) == 1;
    let vram = if available {
        match (row.vram_used, row.vram_total) {
            (Some(used), Some(total)) if total > 0.0 => percentage_f64(used / total * 100.0),
            _ => None,
        }
    } else {
        None
    };
    Readings {
        cpu: row.cpu.and_then(percentage_f64),
        ram: row.ram.and_then(percentage_f64),
        gpu: if available {
            row.gpu.and_then(percentage_f64)
        } else {
            None
        },
        vram,
    }
}

/// Extract readings from a raw stored payload (used by the rollup, which
/// reads payloads rather than dialect-specific SQL).
pub fn readings_from_payload(payload: &str) -> Readings {
    let Ok(metrics) = serde_json::from_str::<Value>(payload) else {
        return Readings::default();
    };

    let gpu = metrics.get("gpu");
    let first = gpu
        .and_then(|gpu| gpu.get("gpus"))
        .and_then(Value::as_array)
        .and_then(|gpus| gpus.first())
        .or(gpu);
    let available = gpu
        .and_then(|gpu| gpu.get("available"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let used = first
        .and_then(|gpu| gpu.get("memUsed"))
        .and_then(Value::as_f64);
    let total = first
        .and_then(|gpu| gpu.get("memTotal"))
        .and_then(Value::as_f64);

    Readings {
        cpu: metrics
            .get("cpu")
            .and_then(|cpu| cpu.get("percent"))
            .and_then(percentage),
        ram: metrics
            .get("mem")
            .and_then(|mem| mem.get("percent"))
            .and_then(percentage),
        gpu: if available {
            first.and_then(|gpu| gpu.get("util")).and_then(percentage)
        } else {
            None
        },
        vram: if available {
            match (used, total) {
                (Some(used), Some(total)) if total > 0.0 => percentage_f64(used / total * 100.0),
                _ => None,
            }
        } else {
            None
        },
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub count: usize,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub p90: f64,
    pub p95: f64,
    pub p99: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FieldStats {
    pub cpu: Option<Stats>,
    pub ram: Option<Stats>,
    pub gpu: Option<Stats>,
    pub vram: Option<Stats>,
}

impl FieldStats {
    fn as_array_mut(&mut self) -> [&mut Option<Stats>; 4] {
        [&mut self.cpu, &mut self.ram, &mut self.gpu, &mut self.vram]
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesPoint {
    pub time: String,
    pub cpu: Option<f64>,
    pub ram: Option<f64>,
    pub gpu: Option<f64>,
    pub vram: Option<f64>,
}

/// The chart/stats summary shared by both tiers.
#[derive(Debug, Clone)]
pub struct Summary {
    pub samples: usize,
    pub first_sample: Option<i64>,
    pub last_sample: Option<i64>,
    pub bucket_seconds: f64,
    pub stats: FieldStats,
    pub series: Vec<SeriesPoint>,
}

/// Nearest-rank summary over a list of readings.
fn summarize(values: &mut [f64]) -> Option<Stats> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let percentile = |p: f64| {
        let index = ((p * values.len() as f64).ceil() as usize).saturating_sub(1);
        values[index.min(values.len() - 1)]
    };
    Some(Stats {
        count: values.len(),
        min: values[0],
        max: values[values.len() - 1],
        mean: values.iter().sum::<f64>() / values.len() as f64,
        p90: percentile(0.90),
        p95: percentile(0.95),
        p99: percentile(0.99),
    })
}

/// Bucket `(time, readings)` pairs into at most `points` chart buckets and
/// compute the stats. Shared by the raw and the hourly tiers.
fn summarize_readings(
    entries: &[(i64, Readings)],
    from_ms: i64,
    to_ms: i64,
    points: usize,
) -> Summary {
    let span = (to_ms - from_ms).max(0);
    let bucket_ms = (((span as f64) / points as f64).ceil() as i64).max(1000);

    let mut buckets: BTreeMap<usize, [Vec<f64>; 4]> = BTreeMap::new();
    let mut values: [Vec<f64>; 4] = std::array::from_fn(|_| Vec::new());
    let mut first: Option<i64> = None;
    let mut last: Option<i64> = None;
    let mut samples = 0usize;

    for (time, reading) in entries {
        if reading.is_empty() {
            continue;
        }
        first = Some(first.map_or(*time, |current| current.min(*time)));
        last = Some(last.map_or(*time, |current| current.max(*time)));
        samples += 1;

        let index = (((*time - from_ms) as f64 / bucket_ms as f64).floor() as isize)
            .clamp(0, points as isize - 1) as usize;
        let bucket = buckets
            .entry(index)
            .or_insert_with(|| std::array::from_fn(|_| Vec::new()));
        for (slot, value) in reading.as_array().into_iter().enumerate() {
            if let Some(value) = value {
                values[slot].push(value);
                bucket[slot].push(value);
            }
        }
    }

    let series = buckets
        .into_iter()
        .map(|(index, bucket)| SeriesPoint {
            time: iso_millis(from_ms + index as i64 * bucket_ms),
            cpu: average(&bucket[0]),
            ram: average(&bucket[1]),
            gpu: average(&bucket[2]),
            vram: average(&bucket[3]),
        })
        .collect();

    Summary {
        samples,
        first_sample: first,
        last_sample: last,
        bucket_seconds: bucket_ms as f64 / 1000.0,
        stats: FieldStats {
            cpu: summarize(&mut values[0]),
            ram: summarize(&mut values[1]),
            gpu: summarize(&mut values[2]),
            vram: summarize(&mut values[3]),
        },
        series,
    }
}

fn average(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

/// Build the summary over raw reading rows.
pub fn history_summary(rows: &[ScalarRow], from_ms: i64, to_ms: i64) -> Summary {
    let entries: Vec<(i64, Readings)> = rows
        .iter()
        .filter_map(|row| {
            let time = metric_time(&row.time)?;
            if time < from_ms || time > to_ms {
                return None;
            }
            let reading = readings(row);
            if reading.is_empty() {
                return None;
            }
            Some((time, reading))
        })
        .collect();
    summarize_readings(&entries, from_ms, to_ms, 240)
}

/// Summary over hourly rollups.
///
/// Charts and percentiles describe hourly averages — that is what the tier
/// honestly has. The one thing averages must not lose is the peak: min and
/// max come from the stored extremes, so "Peak" stays the true maximum of
/// the underlying readings. `samples` reports the raw readings rolled up,
/// not the number of buckets.
///
/// (The Node original gates the hourly GPU/VRAM readings on a
/// `gpu_available` field that the mapped rows never carry, silently
/// dropping them; the averages are used here, which is what the tier
/// intends. Unobservable on GPU-less fleets.)
pub fn hourly_summary(rows: &[HourlyRow], from_ms: i64, to_ms: i64) -> Summary {
    let entries: Vec<(i64, Readings)> = rows
        .iter()
        .filter_map(|row| {
            let time = metric_time(&row.time)?;
            if time < from_ms || time > to_ms {
                return None;
            }
            let reading = Readings {
                cpu: row.cpu_avg.and_then(percentage_f64),
                ram: row.ram_avg.and_then(percentage_f64),
                gpu: row.gpu_avg.and_then(percentage_f64),
                vram: row.vram_avg.and_then(percentage_f64),
            };
            if reading.is_empty() {
                return None;
            }
            Some((time, reading))
        })
        .collect();

    let mut summary = summarize_readings(&entries, from_ms, to_ms, 240);

    let mut samples = 0usize;
    let mut extremes: [(Option<f64>, Option<f64>); 4] = Default::default();
    for row in rows {
        samples += row.samples.max(0) as usize;
        let pairs = [
            (row.cpu_min, row.cpu_max),
            (row.ram_min, row.ram_max),
            (row.gpu_min, row.gpu_max),
            (row.vram_min, row.vram_max),
        ];
        for (slot, (min, max)) in pairs.into_iter().enumerate() {
            if let Some(min) = min.and_then(percentage_f64) {
                extremes[slot].0 = Some(extremes[slot].0.map_or(min, |current| current.min(min)));
            }
            if let Some(max) = max.and_then(percentage_f64) {
                extremes[slot].1 = Some(extremes[slot].1.map_or(max, |current| current.max(max)));
            }
        }
    }

    for (slot, stats) in summary.stats.as_array_mut().into_iter().enumerate() {
        let Some(stats) = stats else {
            continue;
        };
        if let Some(min) = extremes[slot].0 {
            stats.min = min;
        }
        if let Some(max) = extremes[slot].1 {
            stats.max = max;
        }
    }
    if samples > 0 {
        summary.samples = samples;
    }

    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scalar(time: i64, cpu: Option<f64>, ram: Option<f64>) -> ScalarRow {
        ScalarRow {
            time: iso_millis(time)
                .replace('T', " ")
                .trim_end_matches('Z')
                .to_string(),
            cpu,
            ram,
            gpu_available: None,
            gpu: None,
            vram_used: None,
            vram_total: None,
        }
    }

    #[test]
    fn percentage_clamps_and_accepts_strings() {
        assert_eq!(percentage(&json!(42.5)), Some(42.5));
        assert_eq!(percentage(&json!("95")), Some(95.0));
        assert_eq!(percentage(&json!(120)), None);
        assert_eq!(percentage(&json!(-1)), None);
        assert_eq!(percentage(&json!(null)), None);
        assert_eq!(percentage(&json!("null")), None);
    }

    #[test]
    fn payload_readings_handle_gpu_shapes() {
        let modern = json!({
            "cpu": { "percent": 10.0 },
            "mem": { "percent": 20.0 },
            "gpu": { "available": true, "gpus": [ { "util": 30.0, "memUsed": 25, "memTotal": 100 } ] }
        });
        let reading = readings_from_payload(&modern.to_string());
        assert_eq!(reading.cpu, Some(10.0));
        assert_eq!(reading.gpu, Some(30.0));
        assert_eq!(reading.vram, Some(25.0));

        let legacy = json!({
            "gpu": { "available": true, "util": 40.0, "memUsed": 50, "memTotal": 200 }
        });
        let reading = readings_from_payload(&legacy.to_string());
        assert_eq!(reading.gpu, Some(40.0));
        assert_eq!(reading.vram, Some(25.0));

        let none = readings_from_payload(&json!({ "gpu": { "available": false } }).to_string());
        assert!(none.gpu.is_none() && none.vram.is_none());
        assert!(readings_from_payload("not json").is_empty());
    }

    #[test]
    fn summary_buckets_and_percentiles() {
        let now = 1_800_000_000_000_i64;
        let from = now - 3_600_000;
        let rows = vec![
            scalar(now - 3_000_000, Some(10.0), Some(50.0)),
            scalar(now - 2_000_000, Some(20.0), Some(60.0)),
            scalar(now - 1_000_000, Some(30.0), Some(70.0)),
            scalar(now, Some(40.0), Some(80.0)),
        ];

        let summary = history_summary(&rows, from, now);
        assert_eq!(summary.samples, 4);
        assert_eq!(summary.stats.cpu.as_ref().unwrap().min, 10.0);
        assert_eq!(summary.stats.cpu.as_ref().unwrap().max, 40.0);
        assert_eq!(summary.stats.cpu.as_ref().unwrap().mean, 25.0);
        assert!(summary.stats.gpu.is_none());
        assert_eq!(summary.bucket_seconds, 15.0, "3600s / 240 points");
        assert!(!summary.series.is_empty());

        // Rows outside the window are ignored.
        let empty = history_summary(&rows, now - 1_500_000, now);
        assert_eq!(empty.samples, 2);
    }

    #[test]
    fn hourly_summary_uses_stored_extremes() {
        let now = 1_800_000_000_000_i64;
        let from = now - 7_200_000;
        let rows = vec![HourlyRow {
            time: iso_millis(now - 3_600_000)
                .replace('T', " ")
                .trim_end_matches('Z')
                .to_string(),
            samples: 120,
            cpu_min: Some(5.0),
            cpu_max: Some(99.0),
            cpu_avg: Some(50.0),
            ram_min: None,
            ram_max: None,
            ram_avg: Some(60.0),
            gpu_min: None,
            gpu_max: None,
            gpu_avg: None,
            vram_min: None,
            vram_max: None,
            vram_avg: None,
        }];

        let summary = hourly_summary(&rows, from, now);
        assert_eq!(summary.samples, 120, "samples report raw readings");
        let cpu = summary.stats.cpu.as_ref().unwrap();
        assert_eq!(cpu.min, 5.0);
        assert_eq!(cpu.max, 99.0, "peak survives the averages");
        assert_eq!(cpu.mean, 50.0);
    }
}
