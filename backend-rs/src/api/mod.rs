//! HTTP API: router assembly, the error envelope, and the handlers.

pub mod auth;
pub mod monitors;
pub mod stream;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router, middleware};
use serde_json::{Value, json};

use crate::AppState;

/// An error rendered as the Node-compatible envelope:
/// `{ok:false, error, message}` with the right status code.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub error: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error: "bad_request",
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            error: "not_found",
            message: message.into(),
        }
    }

    pub fn server() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error: "server_error",
            message: "Internal error.".to_string(),
        }
    }

    pub fn stream_limit() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            error: "stream_limit",
            message: "Too many live connections.".to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "ok": false, "error": self.error, "message": self.message })),
        )
            .into_response()
    }
}

/// Assemble the API router.
///
/// Public: `/api/v1/auth/setup` and `/api/v1/auth/login` (the sign-in flow
/// cannot require a token). Everything else under `/api/v1` needs a bearer
/// token. The push endpoint (M2) authenticates by monitor token in the path.
pub fn router(state: AppState) -> Router {
    let public = Router::new()
        .route("/api/v1/auth/setup", get(auth::setup_status))
        .route("/api/v1/auth/login", post(auth::login));

    let authed = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/auth/me", get(auth::me))
        .route(
            "/api/v1/monitors",
            get(monitors::list).post(monitors::create),
        )
        .route(
            "/api/v1/monitors/{id}",
            get(monitors::get_one)
                .patch(monitors::patch)
                .delete(monitors::delete),
        )
        .route("/api/v1/monitor-types", get(monitor_types))
        .route("/api/v1/events", get(stream::events))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_token,
        ));

    public.merge(authed).with_state(state)
}

/// One row of the health query: monitor plus its latest heartbeat status.
#[derive(sqlx::FromRow)]
struct HealthRow {
    id: i64,
    active: i64,
    name: String,
    url: Option<String>,
    status: Option<i64>,
}

/// Aggregate health across all monitors.
///
/// Shape matches the Node backend: `{ok, health: {total, up, down, pending,
/// maintenance, paused, downMonitors, status}}`.
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let rows: Vec<HealthRow> = sqlx::query_as(
        "SELECT m.id, m.active, m.name, m.url,
                (SELECT h.status FROM heartbeats h
                  WHERE h.monitor_id = m.id
                  ORDER BY h.time DESC, h.id DESC LIMIT 1) AS status
         FROM monitors m",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut total = 0;
    let mut up = 0;
    let mut down = 0;
    let mut pending = 0;
    let mut paused = 0;
    let mut down_monitors: Vec<Value> = Vec::new();

    for row in rows {
        total += 1;
        if row.active == 0 {
            paused += 1;
            continue;
        }
        match row.status {
            Some(1) => up += 1,
            Some(0) => {
                down += 1;
                down_monitors.push(json!({ "id": row.id, "name": row.name, "url": row.url }));
            }
            // 2 pending, 3 maintenance, absent = pending. Maintenance is
            // out of scope in this backend, so 3 can only arrive imported.
            Some(3) => {}
            _ => pending += 1,
        }
    }

    Json(json!({
        "ok": true,
        "health": {
            "total": total,
            "up": up,
            "down": down,
            "pending": pending,
            "maintenance": 0,
            "paused": paused,
            "downMonitors": down_monitors,
            "status": if down > 0 { "down" } else { "up" },
        }
    }))
}

/// Types and writable fields, as the monitor form expects.
async fn monitor_types() -> impl IntoResponse {
    let types = json!({
        "http": { "name": "HTTP", "supportsConditions": false, "allowCustomStatus": false },
        "https": { "name": "HTTPS", "supportsConditions": false, "allowCustomStatus": false },
        "push": { "name": "Push", "supportsConditions": false, "allowCustomStatus": false },
        "group": { "name": "Group", "supportsConditions": false, "allowCustomStatus": false },
    });

    Json(json!({
        "ok": true,
        "count": crate::monitors::TYPES.len(),
        "types": types,
        "writableFields": crate::monitors::WRITABLE_FIELDS,
    }))
}
