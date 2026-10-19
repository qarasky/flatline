//! Operator and agent HTTP handlers for backup agents and runs.
//!
//! Operator routes sit behind the existing token middleware and live under
//! `/api/v1/backup-agents` and `/api/v1/backup-runs`. Agent routes under
//! `/api/backup/v1` use a dedicated backup credential and are scoped to the
//! authenticated agent UUID.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::ApiError;
use crate::backups::{
    self, AgentPatch, Error as BackupError, FailureReport, NewAgent, RunSummary, StartRun,
};

/// Authenticated agent id, inserted by [`require_agent`].
#[derive(Debug, Clone)]
pub struct AgentId(pub String);

fn api_error(error: BackupError) -> ApiError {
    match error {
        BackupError::BadRequest(message) => ApiError::bad(message),
        BackupError::NotFound(message) => ApiError::not_found(message),
        BackupError::Conflict(message) => ApiError {
            status: StatusCode::CONFLICT,
            error: "conflict",
            message,
        },
        BackupError::Unauthorized => ApiError {
            status: StatusCode::UNAUTHORIZED,
            error: "unauthorized",
            message: "Missing or invalid token.".to_string(),
        },
        BackupError::Unavailable(message) => ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            error: "unavailable",
            message,
        },
        BackupError::Insufficient(message) => ApiError {
            status: StatusCode::INSUFFICIENT_STORAGE,
            error: "insufficient_storage",
            message,
        },
        BackupError::TooLarge(message) => ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            error: "too_large",
            message,
        },
        BackupError::HashMismatch(message) => ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            error: "hash_mismatch",
            message,
        },
        BackupError::Internal(message) => {
            tracing::error!("backup service error: {message}");
            ApiError::server()
        }
    }
}

/// Middleware for `/api/backup/v1`: only an active backup credential passes.
pub async fn require_agent(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty());

    let Some(token) = provided else {
        return crate::auth::unauthorized();
    };

    match backups::agents::authenticate(&state.pool, token).await {
        Ok(Some(agent_id)) => {
            request.extensions_mut().insert(AgentId(agent_id));
            next.run(request).await
        }
        Ok(None) => crate::auth::unauthorized(),
        Err(error) => {
            tracing::error!("backup agent auth failed: {error}");
            crate::auth::unauthorized()
        }
    }
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct AgentListQuery {
    #[serde(rename = "monitorId")]
    monitor_id: Option<i64>,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct RunListQuery {
    limit: Option<i64>,
    cursor: Option<String>,
}

/// GET /api/v1/backup-agents
pub async fn list_agents(
    State(state): State<AppState>,
    Query(query): Query<AgentListQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (agents, next) = state
        .backups
        .list_agents(
            query.monitor_id,
            query.limit.unwrap_or(50),
            query.cursor.as_deref(),
        )
        .await
        .map_err(api_error)?;

    Ok(Json(
        serde_json::json!({ "ok": true, "agents": agents, "nextCursor": next }),
    ))
}

/// POST /api/v1/backup-agents
pub async fn create_agent(
    State(state): State<AppState>,
    Json(input): Json<NewAgent>,
) -> Result<Response, ApiError> {
    let (agent, token) = state
        .backups
        .register_agent(input)
        .await
        .map_err(api_error)?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "ok": true, "agent": agent, "token": token })),
    )
        .into_response())
}

/// PATCH /api/v1/backup-agents/{id}
pub async fn patch_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(patch): Json<AgentPatch>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let agent = state
        .backups
        .patch_agent(&id, patch)
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "agent": agent })))
}

/// POST /api/v1/backup-agents/{id}/rotate-token
pub async fn rotate_token(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (agent, token) = state.backups.rotate_token(&id).await.map_err(api_error)?;
    Ok(Json(
        serde_json::json!({ "ok": true, "agent": agent, "token": token }),
    ))
}

/// POST /api/v1/backup-agents/{id}/revoke-token
pub async fn revoke_token(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let agent = state.backups.revoke_token(&id).await.map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "agent": agent })))
}

/// GET /api/v1/backup-agents/{id}/runs
pub async fn list_runs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<RunListQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (runs, next) = state
        .backups
        .list_runs(&id, query.limit.unwrap_or(20), query.cursor.as_deref())
        .await
        .map_err(api_error)?;
    Ok(Json(
        serde_json::json!({ "ok": true, "runs": runs, "nextCursor": next }),
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationInput {
    kind: String,
    status: String,
    checked_at: String,
    summary: String,
}

/// POST /api/v1/backup-runs/{id}/verification
pub async fn verify_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<VerificationInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let run = state
        .backups
        .verify_run(
            &id,
            &input.kind,
            &input.status,
            &input.checked_at,
            &input.summary,
        )
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "run": run })))
}

/// GET /api/backup/v1/runs/{id} (agent-scoped)
pub async fn agent_run(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let run: RunSummary = state
        .backups
        .run_for_agent(&agent_id, &id)
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "run": run })))
}

/// POST /api/backup/v1/runs (agent-scoped)
pub async fn agent_start_run(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Json(input): Json<StartRun>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let run = state
        .backups
        .start_run(&agent_id, input)
        .await
        .map_err(api_error)?;
    let offset = run.received_bytes;
    Ok(Json(
        serde_json::json!({ "ok": true, "run": run, "offset": offset }),
    ))
}

fn required_header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad(format!("{name} header is required")))
}

/// PUT /api/backup/v1/runs/{id}/chunks/{index} (agent-scoped)
pub async fn agent_put_chunk(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Path((run_id, index)): Path<(String, u64)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<serde_json::Value>, ApiError> {
    let offset: u64 = required_header(&headers, "x-backup-offset")?
        .parse()
        .map_err(|_| ApiError::bad("X-Backup-Offset must be an unsigned integer"))?;
    let sha256 = required_header(&headers, "x-backup-sha256")?;

    let run = state
        .backups
        .put_chunk(&agent_id, &run_id, index, offset, sha256, body)
        .await
        .map_err(api_error)?;
    let offset = run.received_bytes;
    Ok(Json(
        serde_json::json!({ "ok": true, "run": run, "offset": offset }),
    ))
}

/// POST /api/backup/v1/runs/{id}/complete (agent-scoped)
pub async fn agent_complete(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let run = state
        .backups
        .complete_run(&agent_id, &id)
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "run": run })))
}

/// GET /api/v1/backup-runs/{id}/download
///
/// Streams only completed retained bundles. The response is never cached and
/// the download URL carries no credential of its own.
pub async fn download_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let bundle = state.backups.open_bundle(&id).await.map_err(api_error)?;

    let stream = ReaderStream::new(bundle.file);
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(CONTENT_LENGTH, bundle.length)
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", bundle.filename),
        )
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(|_| ApiError::server())
}

/// POST /api/backup/v1/failures (agent-scoped)
pub async fn agent_failure(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Json(input): Json<FailureReport>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let run = state
        .backups
        .report_failure(&agent_id, input)
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "run": run })))
}
