//! Metrics read APIs: bulk latest for the Superboard, single latest, the
//! windowed two-tier summary and raw history.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::api::monitors::load;
use crate::metrics::{history, ingest, iso_millis, sql_time_millis};

/// GET /api/v1/monitors/metrics/latest?ids=4,5,6
///
/// Unknown ids and monitors with no samples come back as null entries
/// rather than failing the batch — a 404 per id is exactly how the board
/// discovers which monitors are servers, and that must stay cheap.
pub async fn latest_bulk(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let raw = params.get("ids").map(String::as_str).unwrap_or("");

    let mut seen = HashSet::new();
    let ids: Vec<i64> = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|part| part.parse::<i64>().ok())
        .filter(|id| seen.insert(*id))
        .take(200)
        .collect();

    if ids.is_empty() {
        return Err(ApiError::bad(
            "`ids` must be a comma-separated list of monitor ids, e.g. ?ids=4,5,6 (max 200).",
        ));
    }

    let placeholders = vec!["?"; ids.len()].join(",");
    let existing_sql = format!("SELECT id FROM monitors WHERE id IN ({placeholders})");
    let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(existing_sql));
    for id in &ids {
        query = query.bind(id);
    }
    let existing: HashSet<i64> = query
        .fetch_all(&state.pool)
        .await
        .map_err(internal)?
        .into_iter()
        .collect();

    let mut samples = Map::new();
    let mut missing = Vec::new();
    for id in &ids {
        if !existing.contains(id) {
            continue;
        }
        match state.metrics.latest_json(*id) {
            Some(sample) => {
                samples.insert(id.to_string(), sample);
            }
            None => missing.push(*id),
        }
    }

    // Indexed latest-row lookups for monitors with no cached sample.
    if !missing.is_empty() {
        let placeholders = vec!["?"; missing.len()].join(",");
        let sql = format!(
            "SELECT m.id AS monitor_id, s.time AS time, s.payload AS payload FROM monitors m
             JOIN metrics_raw s ON s.id = (SELECT id FROM metrics_raw
                WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1)
             WHERE m.id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, (i64, String, String)>(sqlx::AssertSqlSafe(sql));
        for id in &missing {
            query = query.bind(id);
        }
        for (monitor_id, time, payload) in query.fetch_all(&state.pool).await.map_err(internal)? {
            // Skip an unreadable row rather than failing the batch.
            if let Ok(metrics) = serde_json::from_str::<Value>(&payload) {
                samples.insert(
                    monitor_id.to_string(),
                    json!({ "time": time, "metrics": metrics }),
                );
            }
        }
    }

    for id in &ids {
        samples.entry(id.to_string()).or_insert(Value::Null);
    }

    Ok(Json(json!({
        "ok": true,
        "count": ids.len(),
        "samples": samples,
    })))
}

/// GET /api/v1/monitors/{id}/metrics/latest
pub async fn latest_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let monitor = load(&state.pool, id).await?;

    if let Some(sample) = state.metrics.latest_json(monitor.id) {
        return Ok(Json(json!({
            "ok": true,
            "monitorId": monitor.id,
            "time": sample["time"],
            "metrics": sample["metrics"],
            "cpuPeak10m": sample["cpuPeak10m"],
        })));
    }

    match ingest::load_latest(&state.pool, monitor.id).await {
        Some((time, metrics)) => Ok(Json(json!({
            "ok": true,
            "monitorId": monitor.id,
            "time": time,
            "metrics": metrics,
        }))),
        None => Err(ApiError::not_found(format!(
            "No metrics recorded for monitor {} yet.",
            monitor.id
        ))),
    }
}

/// GET /api/v1/monitors/{id}/metrics/summary?hours=
///
/// Two tiers, one response shape: raw 30s samples answer windows up to a
/// week; beyond that the hourly rollups do.
pub async fn summary(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let monitor = load(&state.pool, id).await?;

    let hours = match params.get("hours") {
        Some(raw) => raw
            .parse::<f64>()
            .ok()
            .filter(|hours| hours.is_finite() && *hours > 0.0 && *hours <= 17520.0)
            .ok_or_else(|| {
                ApiError::bad("`hours` must be positive and at most 17520 (two years).")
            })?,
        None => 1.0,
    };
    let hours_json = if hours.fract() == 0.0 {
        json!(hours as i64)
    } else {
        json!(hours)
    };

    let now_ms = Utc::now().timestamp_millis();
    let from_ms = now_ms - (hours * 3_600_000.0) as i64;
    let from = iso_millis(from_ms);
    let to = iso_millis(now_ms);

    if hours > 168.0 {
        let rows = history::hourly_rows(
            &state.pool,
            monitor.id,
            &sql_time_millis(from_ms),
            &sql_time_millis(now_ms),
            history::MAX_HISTORY_ROWS + 1,
        )
        .await
        .map_err(internal)?;
        let capped = rows.len() > history::MAX_HISTORY_ROWS;
        let summary = history::hourly_summary(
            &rows[..rows.len().min(history::MAX_HISTORY_ROWS)],
            from_ms,
            now_ms,
        );
        return Ok(Json(json!({
            "ok": true,
            "monitorId": monitor.id,
            "hours": hours_json,
            "from": from,
            "to": to,
            "capped": capped,
            "percentileMethod": "nearest-rank",
            "basis": "hourly rollups (min/max/average per metric); percentiles describe hourly averages, while peak is the true maximum of the underlying readings",
            "samples": summary.samples,
            "firstSample": summary.first_sample.map(iso_millis),
            "lastSample": summary.last_sample.map(iso_millis),
            "bucketSeconds": summary.bucket_seconds,
            "stats": summary.stats,
            "series": summary.series,
        })));
    }

    let rows = history::scalar_rows(
        &state.pool,
        monitor.id,
        &sql_time_millis(from_ms),
        &sql_time_millis(now_ms),
        history::MAX_HISTORY_ROWS + 1,
    )
    .await
    .map_err(internal)?;
    let capped = rows.len() > history::MAX_HISTORY_ROWS;
    let summary = history::history_summary(
        &rows[..rows.len().min(history::MAX_HISTORY_ROWS)],
        from_ms,
        now_ms,
    );

    Ok(Json(json!({
        "ok": true,
        "monitorId": monitor.id,
        "hours": hours_json,
        "from": from,
        "to": to,
        "capped": capped,
        "percentileMethod": "nearest-rank",
        "basis": "archived snapshots (normally 30 seconds); not raw 1Hz telemetry",
        "samples": summary.samples,
        "firstSample": summary.first_sample.map(iso_millis),
        "lastSample": summary.last_sample.map(iso_millis),
        "bucketSeconds": summary.bucket_seconds,
        "stats": summary.stats,
        "series": summary.series,
    })))
}

/// GET /api/v1/monitors/{id}/metrics?hours=
///
/// Raw rows, newest first, capped at a week and 1000 rows — the AI-facing
/// view, deliberately not the chart path.
pub async fn raw(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let monitor = load(&state.pool, id).await?;

    let mut hours = 24.0_f64;
    if let Some(raw) = params.get("hours") {
        let parsed = raw
            .parse::<f64>()
            .ok()
            .filter(|hours| hours.is_finite() && *hours > 0.0)
            .ok_or_else(|| ApiError::bad("`hours` must be a positive number."))?;
        hours = parsed.min(168.0);
    }
    let hours_json = if hours.fract() == 0.0 {
        json!(hours as i64)
    } else {
        json!(hours)
    };

    let limit = 1000usize;
    let cutoff = iso_millis(Utc::now().timestamp_millis() - (hours * 3_600_000.0) as i64);
    let cutoff = cutoff[..19].replace('T', " ");

    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT time, payload FROM metrics_raw
         WHERE monitor_id = ? AND time >= ?
         ORDER BY time DESC, id DESC LIMIT ?",
    )
    .bind(monitor.id)
    .bind(cutoff)
    .bind((limit + 1) as i64)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;

    let capped = rows.len() > limit;
    let mut metrics = Vec::new();
    for (time, payload) in rows.into_iter().take(limit) {
        // Skip an unreadable row rather than failing the whole window.
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            metrics.push(json!({ "time": time, "metrics": value }));
        }
    }

    Ok(Json(json!({
        "ok": true,
        "monitorId": monitor.id,
        "count": metrics.len(),
        "capped": capped,
        "hours": hours_json,
        "metrics": metrics,
    })))
}

fn internal(error: sqlx::Error) -> ApiError {
    tracing::error!("metrics api: {error}");
    ApiError::server()
}
