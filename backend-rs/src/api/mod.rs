//! HTTP API: router assembly, the error envelope, and the handlers.

pub mod api_keys;
pub mod auth;
pub mod backups;
pub mod badges;
pub mod limits;
pub mod links;
pub mod metrics;
pub mod monitors;
pub mod notifications;
pub mod openapi;
pub mod provisioning;
pub mod public_cache;
pub mod push;
pub mod status_pages;
pub mod stream;
pub mod web;

use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
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
/// Public: the sign-in flow, the agent push endpoint (monitor token in the
/// path), badges, the status-page read API, `robots.txt` and the OpenAPI
/// document. Everything else under `/api/v1` needs a bearer token. The SPA
/// fallback answers the remaining GET/HEAD paths when a build exists.
///
/// Request budgets are applied per route group (see [`limits`]): most
/// groups get [`limits::DEFAULT_TIMEOUT`] and a slot from the instance-wide
/// in-flight cap; the public reads get a shorter timeout and their own,
/// tighter concurrency limit; the SSE stream and agent binary downloads are
/// deliberately exempt from the timeout. A new long-running group (uploads)
/// must be merged with its own budget rather than the default.
pub fn router(state: AppState) -> Router {
    let public = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/auth/setup", get(auth::setup_status))
        .route("/api/v1/auth/login", post(auth::login))
        .route("/api/v1/openapi.json", get(openapi::document))
        .route("/robots.txt", get(status_pages::robots))
        .route("/add-push-server.md", get(provisioning::runbook))
        .route("/llms.txt", get(provisioning::llms))
        .route("/agent/install.sh", get(provisioning::installer))
        .route("/agent/sha256sums", get(provisioning::checksums))
        .route("/agent/version", get(provisioning::version));

    // Serves whatever builds the deployment ships (name: superboard-<os>-<arch>).
    // Static routes above win over this parameter, so version/checksums
    // and the installer are never shadowed. No timeout: the body streams a
    // ~10 MB binary to hosts on slow links.
    let agent_downloads = Router::new().route("/agent/{file}", get(provisioning::agent_file));

    // Status pages and badges: polled by every open page, wall screen and
    // README; cached (`public_cache`) and capped here so a flood cannot
    // starve the pool.
    let public_reads = Router::new()
        .route(
            "/api/status-page/resolve-host",
            get(status_pages::resolve_host),
        )
        .route("/api/status-page/{slug}", get(status_pages::page))
        .route(
            "/api/status-page/heartbeat/{slug}",
            get(status_pages::heartbeat),
        )
        .route(
            "/api/status-page/{slug}/incident-history",
            get(status_pages::incident_history),
        )
        .route(
            "/api/status-page/{slug}/manifest.json",
            get(status_pages::manifest),
        )
        .route("/api/status-page/{slug}/badge", get(status_pages::badge))
        .route(
            "/api/v1/status-pages/unlock/{slug}",
            post(status_pages::unlock),
        )
        .route("/api/badge/{id}/status", get(badges::status))
        .route("/api/badge/{id}/uptime", get(badges::uptime))
        .route(
            "/api/badge/{id}/uptime/{duration}",
            get(badges::uptime_duration),
        )
        .route("/api/badge/{id}/ping", get(badges::ping))
        .route(
            "/api/badge/{id}/ping/{duration}",
            get(badges::ping_duration),
        )
        .route("/api/badge/{id}/avg-response", get(badges::avg_response))
        .route(
            "/api/badge/{id}/avg-response/{duration}",
            get(badges::avg_response_duration),
        )
        .route("/api/badge/{id}/response", get(badges::response));

    // The agent's metrics payloads are capped like the Node backend's JSON
    // parser: 256kb, high enough for a big sample, low enough to reject
    // nonsense before it reaches the handler.
    let agent = Router::new()
        .route("/api/push/{pushToken}", get(push::push).post(push::push))
        .layer(DefaultBodyLimit::max(256 * 1024));

    // Backup agents authenticate with their own credential, never an operator
    // token or a monitor push token; each handler is scoped to the agent
    // UUID. Transfers (chunks, completion, download) are a separate group so
    // they can be exempt from request-wide timeouts.
    let backup_agent = backups::agent_routes(state.clone());
    let backup_transfers = backups::transfer_routes(state.clone());

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
        .route(
            "/api/v1/monitors/{id}/heartbeats",
            get(monitors::heartbeats),
        )
        .route(
            "/api/v1/monitors/{id}/push-failures/clear",
            post(monitors::clear_push_failures),
        )
        .route(
            "/api/v1/monitors/{id}/agent-warnings/clear",
            post(monitors::clear_agent_warnings),
        )
        .route("/api/v1/monitors/links", get(links::bulk))
        .route(
            "/api/v1/monitors/{id}/links",
            get(links::single).put(links::replace).delete(links::clear),
        )
        .route("/api/v1/monitors/metrics/latest", get(metrics::latest_bulk))
        .route(
            "/api/v1/monitors/{id}/metrics/latest",
            get(metrics::latest_one),
        )
        .route(
            "/api/v1/monitors/{id}/metrics/summary",
            get(metrics::summary),
        )
        .route("/api/v1/monitors/{id}/metrics", get(metrics::raw))
        .route(
            "/api/v1/notifications",
            get(notifications::list).post(notifications::create),
        )
        .route(
            "/api/v1/notifications/{id}",
            patch(notifications::patch).delete(notifications::delete),
        )
        .route(
            "/api/v1/api-keys",
            get(api_keys::list).post(api_keys::create),
        )
        .route(
            "/api/v1/api-keys/{id}",
            patch(api_keys::patch).delete(api_keys::delete),
        )
        .route("/api/v1/monitor-types", get(monitor_types))
        .route(
            "/api/v1/backup-agents",
            get(backups::list_agents).post(backups::create_agent),
        )
        .route("/api/v1/backup-agents/{id}", patch(backups::patch_agent))
        .route(
            "/api/v1/backup-agents/{id}/rotate-token",
            post(backups::rotate_token),
        )
        .route(
            "/api/v1/backup-agents/{id}/revoke-token",
            post(backups::revoke_token),
        )
        .route("/api/v1/backup-agents/{id}/runs", get(backups::list_runs))
        .route(
            "/api/v1/backup-runs/{id}/verification",
            post(backups::verify_run),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_token,
        ));

    // The SSE stream: authenticated like the rest, but long-lived by
    // design, so no request timeout.
    let stream = Router::new()
        .route("/api/v1/events", get(stream::events))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::auth::require_token,
        ));

    let standard = |router: Router<AppState>| {
        limits::with_concurrency_limit(
            limits::with_timeout(router, limits::DEFAULT_TIMEOUT),
            &limits::GLOBAL_SLOTS,
            limits::GLOBAL_WAIT,
            limits::global_busy,
        )
    };
    // Exempt groups still take a global slot, released as soon as the
    // response head is out (a streaming body does not hold it).
    let untimed = |router: Router<AppState>| {
        limits::with_concurrency_limit(
            router,
            &limits::GLOBAL_SLOTS,
            limits::GLOBAL_WAIT,
            limits::global_busy,
        )
    };
    let public_reads = limits::with_concurrency_limit(
        limits::with_timeout(public_reads, limits::PUBLIC_TIMEOUT),
        &limits::PUBLIC_SLOTS,
        limits::PUBLIC_WAIT,
        limits::public_busy,
    );

    standard(public)
        .merge(public_reads)
        .merge(untimed(agent_downloads))
        .merge(standard(agent))
        .merge(standard(authed))
        .merge(untimed(stream))
        // Backup agents: control calls take the normal budget; chunk uploads,
        // finalization (hashes up to 8 GiB) and downloads enforce their own
        // body deadlines instead of the request timeout.
        .merge(standard(backup_agent))
        .merge(untimed(backup_transfers))
        .fallback(web::fallback)
        .with_state(state)
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
async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows: Vec<HealthRow> = match sqlx::query_as(
        "SELECT m.id, m.active, m.name, m.url,
                (SELECT h.status FROM heartbeats h
                  WHERE h.monitor_id = m.id
                  ORDER BY h.time DESC, h.id DESC LIMIT 1) AS status
         FROM monitors m",
    )
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        // A9: a database failure used to read as an empty, healthy fleet.
        Err(error) => {
            tracing::error!("health: {error}");
            return Err(ApiError {
                status: StatusCode::SERVICE_UNAVAILABLE,
                error: "unavailable",
                message: "Database unavailable.".to_string(),
            });
        }
    };

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

    Ok(Json(json!({
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
    })))
}

/// Bound on the `/healthz` database probe.
const HEALTHZ_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// `GET /healthz`: unauthenticated liveness for the container healthcheck.
///
/// 200 `{"status":"ok",...}` only when `SELECT 1` answers within 2 s and
/// the engine is running with a fresh watchdog tick (the watchdog also
/// supervises the check loops); otherwise 503 with the reason. Cheap: one
/// trivial query, no table reads, nothing about individual monitors.
async fn healthz(State(state): State<AppState>) -> Response {
    let started = std::time::Instant::now();
    let probe = tokio::time::timeout(
        HEALTHZ_DB_TIMEOUT,
        sqlx::query_scalar::<_, i64>("SELECT 1").fetch_one(&state.pool),
    )
    .await;
    let db = match probe {
        Ok(Ok(1)) => Ok(()),
        Ok(Ok(_)) => Err("database probe returned an unexpected value"),
        Ok(Err(_)) => Err("database error"),
        Err(_) => Err("database probe timed out"),
    };
    let db_ms = started.elapsed().as_millis() as u64;

    let liveness = state.engine.liveness();
    let engine = liveness.check();
    let body = |status: &str, reason: Option<&str>| {
        json!({
            "status": status,
            "reason": reason,
            "db": { "ok": db.is_ok(), "latencyMs": db_ms },
            "engine": {
                "ok": engine.is_ok(),
                "running": liveness.running,
                "tickAgeMs": liveness.tick_age.map(|age| age.as_millis() as u64),
                "loops": liveness.loops,
                "stalled": liveness.stalled,
            },
        })
    };

    match db.and(engine) {
        Ok(()) => (StatusCode::OK, Json(body("ok", None))).into_response(),
        Err(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(body("unavailable", Some(reason))),
        )
            .into_response(),
    }
}

/// Types and writable fields, as the monitor form expects.
async fn monitor_types() -> impl IntoResponse {
    let types = json!({
        "http": { "name": "HTTP", "supportsConditions": false, "allowCustomStatus": false },
        "https": { "name": "HTTPS", "supportsConditions": false, "allowCustomStatus": false },
        "push": { "name": "Push", "supportsConditions": false, "allowCustomStatus": false },
        "ping": { "name": "Ping", "supportsConditions": false, "allowCustomStatus": false },
        "group": { "name": "Group", "supportsConditions": false, "allowCustomStatus": false },
    });

    Json(json!({
        "ok": true,
        "count": crate::monitors::TYPES.len(),
        "types": types,
        "writableFields": crate::monitors::WRITABLE_FIELDS,
    }))
}
