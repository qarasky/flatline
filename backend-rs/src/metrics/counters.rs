//! Server-side CPU utilization from raw agent counters (`cpu-counters.js`).
//!
//! Agents push cumulative CPU-time snapshots (`cpu.counters`) with every
//! sample; this module diffs consecutive snapshots into percentages. The
//! window is whatever separates the two snapshots: ~1s between pushes for
//! live readings, ~30s between archived rows for history.
//!
//! Everything is total: anything incomputable (no counters, no previous
//! snapshot, reset or stalled counters, out-of-order samples) yields None,
//! and the caller keeps the agent's compat percent. A broken collector must
//! degrade to the old numbers, never to NaN or a dropped sample.

use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct CpuCounter {
    pub total: f64,
    pub idle: f64,
}

#[derive(Debug, Clone)]
pub struct CpuCounters {
    pub total: f64,
    pub idle: f64,
    pub per_core: Vec<CpuCounter>,
}

impl CpuCounters {
    fn aggregate(&self) -> CpuCounter {
        CpuCounter {
            total: self.total,
            idle: self.idle,
        }
    }
}

/// Normalize the counters block of one payload, or None when absent or
/// malformed.
pub fn as_counters(cpu: Option<&Value>) -> Option<CpuCounters> {
    let cpu = cpu?;
    let counters = cpu.get("counters")?;

    let pair = |value: Option<&Value>| -> Option<CpuCounter> {
        let value = value?;
        let total = value.get("total")?.as_f64()?;
        let idle = value.get("idle")?.as_f64()?;
        if !total.is_finite() || !idle.is_finite() || total < 0.0 || idle < 0.0 {
            return None;
        }
        Some(CpuCounter { total, idle })
    };

    let aggregate = pair(Some(counters))?;

    let mut per_core = Vec::new();
    if let Some(list) = counters.get("perCore") {
        for entry in list.as_array()? {
            per_core.push(pair(Some(entry))?);
        }
    }

    Some(CpuCounters {
        total: aggregate.total,
        idle: aggregate.idle,
        per_core,
    })
}

/// Utilization between two cumulative snapshots, 0-100, or None when the
/// window carries no information (identical totals, reset/wrapped counters,
/// idle running ahead of total).
pub fn utilization(prev: &CpuCounter, cur: &CpuCounter) -> Option<f64> {
    if cur.total.partial_cmp(&prev.total) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    if cur.idle < prev.idle {
        return None;
    }
    let total_delta = cur.total - prev.total;
    let idle_delta = cur.idle - prev.idle;
    if idle_delta > total_delta {
        return None;
    }
    Some(((1.0 - idle_delta / total_delta) * 100.0).clamp(0.0, 100.0))
}

/// Per-core utilization, or None when the core shapes differ (hotplug):
/// there is no valid previous reading then, and the next pair lines up.
pub fn per_core_utilization(prev: &[CpuCounter], cur: &[CpuCounter]) -> Option<Vec<f64>> {
    if prev.len() != cur.len() {
        return None;
    }
    let mut out = Vec::with_capacity(cur.len());
    for (before, after) in prev.iter().zip(cur) {
        out.push(utilization(before, after)?);
    }
    Some(out)
}

pub struct DerivedCpu {
    pub percent: f64,
    pub per_core: Option<Vec<f64>>,
    pub cores: usize,
}

/// Full-window transform of one snapshot against its predecessor.
pub fn transform_counters(prev: Option<&CpuCounters>, cur: &CpuCounters) -> Option<DerivedCpu> {
    let prev = prev?;
    let percent = utilization(&prev.aggregate(), &cur.aggregate())?;
    // A hotplug mid-window drops the per-core breakdown but keeps the
    // aggregate reading, exactly like the Node transform.
    let per_core = if cur.per_core.is_empty() {
        None
    } else {
        per_core_utilization(&prev.per_core, &cur.per_core)
    };
    Some(DerivedCpu {
        percent,
        per_core,
        cores: cur.per_core.len(),
    })
}

/// Round a derived percentage for storage: board precision is a tenth of a
/// percent, two decimals keep payloads small and stable.
pub fn round_percent(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Apply a derived transform to one payload's cpu block, keeping the
/// agent's per-core breakdown when the core shapes differ and recording the
/// core count from the snapshot that was actually measured.
pub fn apply_derived_cpu(metrics: &mut Value, derived: &DerivedCpu) {
    let Some(object) = metrics.as_object_mut() else {
        return;
    };

    let cpu = object
        .entry("cpu")
        .or_insert_with(|| Value::Object(Default::default()));
    if !cpu.is_object() {
        *cpu = Value::Object(Default::default());
    }
    let Some(cpu) = cpu.as_object_mut() else {
        return;
    };

    cpu.insert("percent".to_string(), json!(round_percent(derived.percent)));
    if let Some(per_core) = &derived.per_core {
        cpu.insert(
            "perCore".to_string(),
            json!(
                per_core
                    .iter()
                    .map(|percent| round_percent(*percent))
                    .collect::<Vec<_>>()
            ),
        );
        cpu.insert("cores".to_string(), json!(per_core.len()));
    } else if cpu
        .get("cores")
        .and_then(Value::as_f64)
        .is_none_or(|cores| !cores.is_finite())
        && derived.cores > 0
    {
        cpu.insert("cores".to_string(), json!(derived.cores));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_well_formed_counters() {
        let good = json!({
            "cpu": {
                "counters": {
                    "total": 1000,
                    "idle": 400,
                    "perCore": [ { "total": 500, "idle": 200 }, { "total": 500, "idle": 200 } ]
                }
            }
        });
        let parsed = as_counters(good.get("cpu")).unwrap();
        assert_eq!(parsed.total, 1000.0);
        assert_eq!(parsed.per_core.len(), 2);

        assert!(as_counters(json!({"percent": 5}).get("cpu")).is_none());
        assert!(as_counters(json!({"counters": {"total": -1, "idle": 0}}).get("cpu")).is_none());
        assert!(
            as_counters(json!({"counters": {"total": 1, "idle": 0, "perCore": [{}]}}).get("cpu"))
                .is_none()
        );
    }

    #[test]
    fn utilization_rejects_resets_and_stalls() {
        let prev = CpuCounter {
            total: 1000.0,
            idle: 400.0,
        };
        // 60% busy: 200 of 500 ticks idle.
        let cur = CpuCounter {
            total: 1500.0,
            idle: 600.0,
        };
        assert_eq!(utilization(&prev, &cur), Some(60.0));
        // Identical or wrapped counters carry no information.
        assert_eq!(utilization(&prev, &prev), None);
        let reset = CpuCounter {
            total: 10.0,
            idle: 5.0,
        };
        assert_eq!(utilization(&prev, &reset), None);
        // Idle moving backwards is a reset in disguise.
        let weird = CpuCounter {
            total: 1500.0,
            idle: 100.0,
        };
        assert_eq!(utilization(&prev, &weird), None);
        // Idle ahead of total is nonsense.
        let impossible = CpuCounter {
            total: 1500.0,
            idle: 1600.0,
        };
        assert_eq!(utilization(&prev, &impossible), None);
    }

    #[test]
    fn transform_keeps_percent_when_core_shapes_change() {
        let prev = CpuCounters {
            total: 1000.0,
            idle: 400.0,
            per_core: vec![
                CpuCounter {
                    total: 500.0,
                    idle: 200.0,
                },
                CpuCounter {
                    total: 500.0,
                    idle: 200.0,
                },
            ],
        };
        let cur = CpuCounters {
            total: 1500.0,
            idle: 600.0,
            per_core: vec![CpuCounter {
                total: 1500.0,
                idle: 600.0,
            }],
        };

        let derived = transform_counters(Some(&prev), &cur).unwrap();
        assert_eq!(derived.percent, 60.0);
        assert!(
            derived.per_core.is_none(),
            "shape change drops per-core only"
        );
        assert_eq!(derived.cores, 1);
    }

    #[test]
    fn derived_cpu_is_rounded_and_applied() {
        let mut metrics = json!({ "cpu": { "percent": 3.0, "cores": 4 } });
        apply_derived_cpu(
            &mut metrics,
            &DerivedCpu {
                percent: 12.3456,
                per_core: Some(vec![10.555, 14.444]),
                cores: 2,
            },
        );
        assert_eq!(metrics["cpu"]["percent"], 12.35);
        assert_eq!(metrics["cpu"]["perCore"][0], 10.56);
        assert_eq!(metrics["cpu"]["cores"], 2);
    }
}
