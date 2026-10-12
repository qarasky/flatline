//! The agent push endpoint: `/api/push/{pushToken}` (+ `?telemetry=1`).
//!
//! Exact contract the Go agent uses today: legacy GET/POST pushes always
//! create a heartbeat; telemetry POSTs on the 1Hz cadence take the fast
//! path (no heartbeat row) while the previous beat is UP and the heartbeat
//! spacing has not elapsed. Metrics storage lands with the M3 pipeline —
//! this endpoint accepts the payload and records the heartbeat.

use std::collections::HashMap;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::AppState;
use crate::heartbeats::{self, DOWN, UP};
use crate::monitors::Monitor;

/// Node's ping ceiling: 100 billion ms (~3.17 years).
const MAX_PING_MS: f64 = 100_000_000_000.0;

/// GET/POST /api/push/{pushToken}
pub async fn push(
    State(state): State<AppState>,
    Path(push_token): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    method: Method,
    body: Bytes,
) -> Response {
    let monitor = match sqlx::query_as::<_, Monitor>(
        "SELECT * FROM monitors WHERE push_token = ? AND active = 1",
    )
    .bind(&push_token)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(monitor)) => monitor,
        Ok(None) => return not_found("Monitor not found or not active."),
        Err(error) => {
            tracing::error!("push: token lookup: {error}");
            return not_found("Monitor not found or not active.");
        }
    };

    let msg = params
        .get("msg")
        .filter(|msg| !msg.is_empty())
        .cloned()
        .unwrap_or_else(|| "OK".to_string());

    // Node: `parseFloat(ping) || null` — a non-numeric ping is no ping;
    // only an out-of-range value is an error.
    let ping = params
        .get("ping")
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite());
    if let Some(value) = ping
        && (value < 0.0 || value > MAX_PING_MS)
    {
        return not_found(&format!(
            "Invalid ping value. Must be between 0 and {MAX_PING_MS} ms."
        ));
    }

    let status_param = params.get("status").map(String::as_str).unwrap_or("up");
    let requested = if status_param == "up" { UP } else { DOWN };
    let explicit_down = status_param == "down";

    // Telemetry fast path: keep the 1Hz cadence live without a heartbeat
    // row per sample. Metrics storage is M3; the response contract is
    // already `{ok:true}` here.
    let payload: Option<Value> = if body.is_empty() {
        None
    } else {
        serde_json::from_slice(&body).ok()
    };
    let has_metrics = payload
        .as_ref()
        .and_then(|value| value.get("metrics"))
        .map(Value::is_object)
        .unwrap_or(false);
    let telemetry = method == Method::POST
        && params.get("telemetry").map(String::as_str) == Some("1")
        && has_metrics;

    if telemetry
        && monitor.upside_down == 0
        && requested == UP
        && let Some(previous) = heartbeats::latest(&state.pool, monitor.id)
            .await
            .ok()
            .flatten()
    {
        // Node: max(1, min(30, interval / 3)) seconds.
        let spacing_ms = (monitor.interval / 3).clamp(1, 30) * 1000;
        let fresh = heartbeats::millis_since(&previous.time)
            .map(|ms| ms < spacing_ms)
            .unwrap_or(false);
        if previous.status == UP && fresh {
            return Json(json!({ "ok": true })).into_response();
        }
    }

    match state
        .engine
        .record_heartbeat(&monitor, requested, ping, &msg, explicit_down)
        .await
    {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(error) => {
            tracing::error!("push: record heartbeat for {}: {error}", monitor.name);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "msg": "Internal error." })),
            )
                .into_response()
        }
    }
}

/// Node parity: every handler error answers 404 with `{ok:false,msg}`.
fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "ok": false, "msg": message })),
    )
        .into_response()
}
