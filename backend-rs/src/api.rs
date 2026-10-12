use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router, middleware};
use serde_json::json;

use crate::AppState;

/// Assemble the API router.
///
/// `/api/v1` sits behind bearer-token auth as a whole; the push endpoint
/// (M2) authenticates by monitor token in the path and is mounted outside
/// this layer. `/api/v1/openapi.json` is public in the Node backend and
/// will be here too.
pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/api/v1/health", get(health))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_token,
        ));

    Router::new().merge(v1).with_state(state)
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
    let mut down_monitors: Vec<serde_json::Value> = Vec::new();

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
