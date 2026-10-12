//! Monitor badges: `/api/badge/{id}/status|uptime|ping|avg-response|response`.
//!
//! Only monitors on a public status-page group get real values; everything
//! else answers an "N/A" badge, like the Node routes. Where Node would throw
//! (no heartbeat yet), a grey N/A is served instead — a badge consumer can
//! do nothing with a JSON error.
//!
//! The duration segment is optional in the Node routes; axum has no
//! optional path parameters, so each duration route has two thin wrappers.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;
use crate::badges::{self, Badge};
use crate::heartbeats;

const NA_COLOR: &str = "#999";
const UP_COLOR: &str = "#66c20a";
const DOWN_COLOR: &str = "#c2290a";
const PENDING_COLOR: &str = "#f8a306";
const MAINTENANCE_COLOR: &str = "#1747f5";
const PING_COLOR: &str = "blue";

fn svg_response(svg: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        svg,
    )
        .into_response()
}

fn na_badge(style: &str) -> Response {
    svg_response(badges::render(&Badge {
        label: "",
        message: "N/A",
        color: NA_COLOR,
        label_color: "",
        style,
    }))
}

/// Node answers `{status:"fail",msg}` 403 for a non-numeric id.
fn invalid_id() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "status": "fail", "msg": "Invalid monitor ID" })),
    )
        .into_response()
}

fn parse_id(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|id| *id > 0)
}

fn style_of(params: &HashMap<String, String>) -> &str {
    badges::query_or(params, "style", "flat")
}

fn labelled(params: &HashMap<String, String>, label: &str) -> String {
    badges::join_parts(&[
        badges::query_string(params, "labelPrefix").to_string(),
        label.to_string(),
    ])
}

/// GET /api/badge/{id}/status
pub async fn status(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let style = style_of(&params);
    let Some(id) = parse_id(&id) else {
        return invalid_id();
    };

    if !badges::is_monitor_public(&state.pool, id).await {
        return na_badge(style);
    }

    let heartbeat: Option<i64> = sqlx::query_scalar(
        "SELECT status FROM heartbeats WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let state_value = badges::query_number(&params, "value")
        .map(|value| value as i64)
        .or(heartbeat);

    let (message, color) = match state_value {
        Some(0) => (
            badges::query_or(&params, "downLabel", "Down"),
            badges::query_or(&params, "downColor", DOWN_COLOR),
        ),
        Some(1) => (
            badges::query_or(&params, "upLabel", "Up"),
            badges::query_or(&params, "upColor", UP_COLOR),
        ),
        Some(2) => (
            badges::query_or(&params, "pendingLabel", "Pending"),
            badges::query_or(&params, "pendingColor", PENDING_COLOR),
        ),
        Some(3) => (
            badges::query_or(&params, "maintenanceLabel", "Maintenance"),
            badges::query_or(&params, "maintenanceColor", MAINTENANCE_COLOR),
        ),
        _ => return na_badge(style),
    };

    let label = badges::query_or(&params, "label", "Status");
    svg_response(badges::render(&Badge {
        label,
        message,
        color,
        label_color: "",
        style,
    }))
}

async fn uptime_impl(
    state: AppState,
    id: String,
    duration: Option<String>,
    params: HashMap<String, String>,
) -> Response {
    let style = style_of(&params);
    let Some(id) = parse_id(&id) else {
        return invalid_id();
    };
    let duration = duration.unwrap_or_else(|| "24h".to_string());
    let Some(seconds) = badges::duration_seconds(&duration) else {
        return invalid_id();
    };

    if !badges::is_monitor_public(&state.pool, id).await {
        return na_badge(style);
    }

    let uptime = heartbeats::uptime_window(&state.pool, id, seconds)
        .await
        .unwrap_or(None)
        .unwrap_or(0.0);

    let clean = match badges::query_number(&params, "value") {
        Some(override_value) => badges::to_precision4(override_value),
        None => badges::to_precision4(uptime * 100.0),
    };
    let color = match params.get("color") {
        Some(color) if !color.is_empty() => color.clone(),
        _ => badges::percentage_to_color(uptime),
    };
    let label_suffix = badges::query_or(&params, "labelSuffix", "h");
    let default_label = format!(
        "Uptime ({}{})",
        duration.trim_end_matches(|c: char| c.is_alphabetic()),
        label_suffix
    );
    let label = match params.get("label") {
        Some(label) => label.clone(),
        None => default_label,
    };
    let message = badges::join_parts(&[
        badges::query_string(&params, "prefix").to_string(),
        clean,
        badges::query_or(&params, "suffix", "%").to_string(),
    ]);

    svg_response(badges::render(&Badge {
        label: &labelled(&params, &label),
        message: &message,
        color: &color,
        label_color: badges::query_string(&params, "labelColor"),
        style,
    }))
}

/// GET /api/badge/{id}/uptime
pub async fn uptime(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    uptime_impl(state, id, None, params).await
}

/// GET /api/badge/{id}/uptime/{duration}
pub async fn uptime_duration(
    State(state): State<AppState>,
    Path((id, duration)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    uptime_impl(state, id, Some(duration), params).await
}

async fn ping_impl(
    state: AppState,
    id: String,
    duration: Option<String>,
    params: HashMap<String, String>,
) -> Response {
    let style = style_of(&params);
    let Some(id) = parse_id(&id) else {
        return invalid_id();
    };
    let duration = duration.unwrap_or_else(|| "24h".to_string());
    let Some(seconds) = badges::duration_seconds(&duration) else {
        return invalid_id();
    };

    if !badges::is_monitor_public(&state.pool, id).await {
        return na_badge(style);
    }

    let Some(average) = badges::average_ping(&state.pool, id, seconds).await else {
        return na_badge(style);
    };
    let value = match badges::query_number(&params, "value") {
        Some(override_value) => override_value,
        None => average,
    } as i64;

    let label_suffix = badges::query_or(&params, "labelSuffix", "h");
    let default_label = format!(
        "Avg. Ping ({}{})",
        duration.trim_end_matches(|c: char| c.is_alphabetic()),
        label_suffix
    );
    let label = match params.get("label") {
        Some(label) => label.clone(),
        None => default_label,
    };
    let message = badges::join_parts(&[
        badges::query_string(&params, "prefix").to_string(),
        value.to_string(),
        badges::query_or(&params, "suffix", "ms").to_string(),
    ]);

    svg_response(badges::render(&Badge {
        label: &labelled(&params, &label),
        message: &message,
        color: badges::query_or(&params, "color", PING_COLOR),
        label_color: badges::query_string(&params, "labelColor"),
        style,
    }))
}

/// GET /api/badge/{id}/ping
pub async fn ping(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    ping_impl(state, id, None, params).await
}

/// GET /api/badge/{id}/ping/{duration}
pub async fn ping_duration(
    State(state): State<AppState>,
    Path((id, duration)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    ping_impl(state, id, Some(duration), params).await
}

async fn avg_response_impl(
    state: AppState,
    id: String,
    duration: Option<String>,
    params: HashMap<String, String>,
) -> Response {
    let style = style_of(&params);
    let Some(id) = parse_id(&id) else {
        return invalid_id();
    };
    // Hours only, default 24, capped at 720 (30 days), like the Node route.
    let hours = duration
        .as_deref()
        .and_then(|raw| raw.parse::<i64>().ok())
        .unwrap_or(24)
        .clamp(1, 720);

    if !badges::is_monitor_public(&state.pool, id).await {
        return na_badge(style);
    }

    let Some(average) = badges::average_ping(&state.pool, id, hours * 3600)
        .await
        .filter(|average| *average > 0.0)
    else {
        return na_badge(style);
    };
    let value = match badges::query_number(&params, "value") {
        Some(override_value) => override_value,
        None => average,
    } as i64;

    let default_label = format!("Avg. Response ({hours}h)");
    let label = match params.get("label") {
        Some(label) => label.clone(),
        None => default_label,
    };
    let message = badges::join_parts(&[
        badges::query_string(&params, "prefix").to_string(),
        value.to_string(),
        badges::query_or(&params, "suffix", "ms").to_string(),
    ]);

    svg_response(badges::render(&Badge {
        label: &labelled(&params, &label),
        message: &message,
        color: badges::query_or(&params, "color", PING_COLOR),
        label_color: badges::query_string(&params, "labelColor"),
        style,
    }))
}

/// GET /api/badge/{id}/avg-response
pub async fn avg_response(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    avg_response_impl(state, id, None, params).await
}

/// GET /api/badge/{id}/avg-response/{duration}
pub async fn avg_response_duration(
    State(state): State<AppState>,
    Path((id, duration)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    avg_response_impl(state, id, Some(duration), params).await
}

/// GET /api/badge/{id}/response — the latest heartbeat's ping.
pub async fn response(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let style = style_of(&params);
    let Some(id) = parse_id(&id) else {
        return invalid_id();
    };

    if !badges::is_monitor_public(&state.pool, id).await {
        return na_badge(style);
    }

    let ping: Option<f64> = sqlx::query_scalar(
        "SELECT ping FROM heartbeats WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let Some(ping) = ping.filter(|ping| *ping > 0.0) else {
        return na_badge(style);
    };
    let value = match badges::query_number(&params, "value") {
        Some(override_value) => override_value,
        None => ping,
    } as i64;

    let label = match params.get("label") {
        Some(label) => label.clone(),
        None => "Response".to_string(),
    };
    let message = badges::join_parts(&[
        badges::query_string(&params, "prefix").to_string(),
        value.to_string(),
        badges::query_or(&params, "suffix", "ms").to_string(),
    ]);

    svg_response(badges::render(&Badge {
        label: &labelled(&params, &label),
        message: &message,
        color: badges::query_or(&params, "color", PING_COLOR),
        label_color: badges::query_string(&params, "labelColor"),
        style,
    }))
}
