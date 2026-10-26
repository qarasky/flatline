//! The agent push endpoint: `/api/push/{pushToken}` (+ `?telemetry=1`).
//!
//! Exact contract the Go agent uses today: legacy GET/POST pushes always
//! create a heartbeat; telemetry POSTs on the 1Hz cadence take the fast
//! path (no heartbeat row) while the previous beat is UP and the heartbeat
//! spacing has not elapsed. Metrics ride along on both paths — and a
//! metrics problem answers 400 without ever pretending the host is dead:
//! the heartbeat is recorded first, only the metrics are dropped.
//!
//! Status codes are a contract with the agent, which quarantines a 400 as
//! permanent and retries everything else: 400 is reserved for payloads that
//! would fail identically on retry (invalid metrics, a non-empty body that
//! is not JSON). A storage failure is transient and answers 503 with a
//! jittered `Retry-After`, so the agent keeps the sample and the fleet does
//! not retry in lockstep against a database that is already struggling.

use std::collections::HashMap;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde_json::{Value, json};

use crate::AppState;
use crate::heartbeats::{self, DOWN, UP};
use crate::metrics::{self, StoreError};
use crate::monitors::Monitor;

/// Node's ping ceiling: 100 billion ms (~3.17 years).
const MAX_PING_MS: f64 = 100_000_000_000.0;
/// `Retry-After` range for storage failures, in seconds (jittered).
pub const RETRY_AFTER_SECS: std::ops::RangeInclusive<u64> = 5..=30;

/// GET/POST /api/push/{pushToken}
pub async fn push(
    State(state): State<AppState>,
    Path(push_token): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    method: Method,
    body: Bytes,
) -> Response {
    // Explicit token-family errors: an operator or backup credential in the
    // push URL is a configuration mistake, not a deleted monitor. Say so
    // instead of answering the generic "not found or not active".
    match crate::auth::token_kind(&push_token) {
        crate::auth::TokenKind::Operator => {
            return crate::auth::operator_token_on_agent_api("/api/push/{pushToken}");
        }
        crate::auth::TokenKind::BackupAgent => {
            return crate::auth::backup_token_on_metric_agent_api("/api/push/{pushToken}");
        }
        crate::auth::TokenKind::Legacy => {
            match crate::auth::known_operator_token(&state.pool, &push_token).await {
                Ok(true) => {
                    return crate::auth::operator_token_on_agent_api("/api/push/{pushToken}");
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::error!("push: token kind check: {error}");
                    return unavailable("Storage unavailable, retry later.");
                }
            }
        }
        crate::auth::TokenKind::PushAgent | crate::auth::TokenKind::Other => {}
    }

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
            // Not a 404: the agent would treat a database hiccup as a bad
            // token. The token was simply not checked.
            tracing::error!("push: token lookup: {error}");
            return unavailable("Storage unavailable, retry later.");
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

    // A body that is present but not JSON used to be accepted with
    // `{"ok":true}` and its metrics silently lost. It still counts as a
    // heartbeat (the host is alive), but the answer is 400 so the sender
    // learns its payload is broken.
    let (payload, body_error): (Option<Value>, Option<String>) =
        if body.iter().all(u8::is_ascii_whitespace) {
            (None, None)
        } else {
            match serde_json::from_slice(&body) {
                Ok(value) => (Some(value), None),
                Err(error) => (None, Some(format!("body is not valid JSON: {error}"))),
            }
        };
    // `metrics` may be any non-null JSON value; validation owns the shape
    // error so a broken payload answers 400 with the Node message.
    let metrics_value = payload
        .as_ref()
        .and_then(|value| value.get("metrics"))
        .filter(|metrics| !metrics.is_null())
        .cloned();
    let telemetry = method == Method::POST
        && params.get("telemetry").map(String::as_str) == Some("1")
        && metrics_value.is_some();
    let now_ms = Utc::now().timestamp_millis();

    // Telemetry fast path: keep the 1Hz cadence live without a heartbeat
    // row per sample.
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
            let metrics_value = metrics_value.expect("telemetry implies metrics");
            let sample_time = metrics::resolve_sample_time(metrics_value.get("sampledAt"), now_ms)
                .unwrap_or_else(|| metrics::sql_time_millis(now_ms));
            return match state
                .metrics
                .store(monitor.id, &sample_time, &metrics_value, true)
                .await
            {
                Ok(()) => {
                    note_sample(&state, &monitor, &metrics_value).await;
                    state.metrics.evaluate_alerts_async(&monitor);
                    Json(json!({ "ok": true })).into_response()
                }
                Err(error) => store_failed(&monitor, "Metrics dropped", &error),
            };
        }
    }

    match state
        .engine
        .record_heartbeat(&monitor, requested, ping, &msg, explicit_down)
        .await
    {
        Ok(beat) => {
            if let Some(error) = &body_error {
                return bad_request(&format!("Heartbeat recorded, metrics dropped: {error}"));
            }
            let Some(metrics_value) = &metrics_value else {
                return Json(json!({ "ok": true })).into_response();
            };
            let sample_time = metrics::resolve_sample_time(metrics_value.get("sampledAt"), now_ms)
                .unwrap_or_else(|| beat.beat.time.clone());
            match state
                .metrics
                .store(monitor.id, &sample_time, metrics_value, telemetry)
                .await
            {
                Ok(()) => {
                    note_sample(&state, &monitor, metrics_value).await;
                    state.metrics.evaluate_alerts_async(&monitor);
                    Json(json!({ "ok": true })).into_response()
                }
                Err(error) => store_failed(&monitor, "Heartbeat recorded, metrics dropped", &error),
            }
        }
        Err(error) => {
            tracing::error!("push: record heartbeat for {}: {error}", monitor.name);
            unavailable("Heartbeat not recorded: storage unavailable, retry later.")
        }
    }
}

/// A stored sample can end a mute: a newly failing disk or a newly full
/// mount on a muted server is a new problem. Best effort; never fails the
/// push.
async fn note_sample(state: &AppState, monitor: &Monitor, sample: &Value) {
    match crate::mutes::on_sample(&state.pool, monitor.id, sample, monitor.metric_disk_threshold)
        .await
    {
        Ok(true) => state.events.invalidate(),
        Ok(false) => {}
        Err(error) => tracing::error!("push: mute update for {}: {error}", monitor.name),
    }
}

/// Map a metrics store failure: payload problems are permanent (400),
/// storage problems transient (503).
fn store_failed(monitor: &Monitor, prefix: &str, error: &StoreError) -> Response {
    match error {
        StoreError::Invalid(message) => bad_request(&format!("{prefix}: {message}")),
        StoreError::Storage(message) => {
            tracing::error!("push: store metrics for {}: {message}", monitor.name);
            unavailable(&format!("{prefix}: storage unavailable, retry later."))
        }
    }
}

/// Node parity: every handler error that is not a storage failure answers
/// 404 with `{ok:false,msg}`.
fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "ok": false, "msg": message })),
    )
        .into_response()
}

/// Storage failures answer 503 with a jittered `Retry-After` (seconds).
fn unavailable(message: &str) -> Response {
    let retry_after = rand::random_range(RETRY_AFTER_SECS);
    let mut response = (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "msg": message })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(retry_after));
    response
}

/// Payload problems answer 400; the heartbeat, when one was recorded, stays.
fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "msg": message })),
    )
        .into_response()
}
