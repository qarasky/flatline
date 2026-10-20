//! Operator and agent HTTP handlers for backup agents and runs.
//!
//! Operator routes sit behind the existing token middleware and live under
//! `/api/v1/backup-agents` and `/api/v1/backup-runs`. Agent routes under
//! `/api/backup/v1` use a dedicated backup credential and are scoped to the
//! authenticated agent UUID.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router, middleware};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::ApiError;
use crate::backups::{
    self, AgentPatch, Error as BackupError, FailureReport, NewAgent, RunSummary, StartRun,
};

/// Agent metadata routes: start, status, abandon and failure reports.
/// Short requests; the global request timeout may apply to this group.
pub fn agent_routes(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/api/backup/v1/runs", post(agent_start_run))
        .route("/api/backup/v1/runs/{id}", get(agent_run))
        .route("/api/backup/v1/runs/{id}/abandon", post(agent_abandon))
        .route("/api/backup/v1/failures", post(agent_failure))
        .route_layer(middleware::from_fn_with_state(state, require_agent))
}

/// Long-running transfer routes: chunk upload, finalization (hashes up to
/// 8 GiB) and bundle download. They carry their own read deadlines and
/// must be exempt from a global request timeout, or be given a budget of
/// several minutes. Each route keeps its own authentication.
pub fn transfer_routes(state: AppState) -> Router<AppState> {
    let agent = || middleware::from_fn_with_state(state.clone(), require_agent);
    let operator = || middleware::from_fn_with_state(state.clone(), crate::auth::require_token);
    Router::new()
        .route(
            "/api/backup/v1/runs/{id}/chunks/{index}",
            put(agent_put_chunk).route_layer(agent()),
        )
        .route(
            "/api/backup/v1/runs/{id}/complete",
            post(agent_complete).route_layer(agent()),
        )
        .route(
            "/api/v1/backup-runs/{id}/download",
            get(download_run).route_layer(operator()),
        )
        .route(
            "/api/v1/backup-runs/{id}/download-ticket",
            post(download_ticket).route_layer(operator()),
        )
        // The ticket is the credential: one run, minutes, one use.
        .route("/api/v1/backup-downloads/{ticket}", get(download_by_ticket))
}

/// Authenticated agent id, inserted by [`require_agent`].
#[derive(Debug, Clone)]
pub struct AgentId(pub String);

/// The shared `{ok:false,error,message}` envelope plus what backup clients
/// need to act on an error without parsing prose: an optional
/// `Retry-After` and extra machine-readable fields.
#[derive(Debug)]
pub struct BackupApiError {
    api: ApiError,
    retry_after: Option<u64>,
    details: serde_json::Map<String, serde_json::Value>,
}

impl From<ApiError> for BackupApiError {
    fn from(api: ApiError) -> Self {
        Self {
            api,
            retry_after: None,
            details: serde_json::Map::new(),
        }
    }
}

impl IntoResponse for BackupApiError {
    fn into_response(self) -> Response {
        let mut body = serde_json::Map::new();
        body.insert("ok".to_string(), false.into());
        body.insert("error".to_string(), self.api.error.into());
        body.insert("code".to_string(), self.api.error.into());
        body.insert("message".to_string(), self.api.message.into());
        if let Some(extra) = self.api.extra {
            if let Some(hint) = extra.hint {
                body.insert("hint".to_string(), hint.into());
            }
            if let Some(details) = extra.details {
                body.insert("details".to_string(), details);
            }
        }
        body.extend(self.details);
        let mut response = (self.api.status, Json(serde_json::Value::Object(body))).into_response();
        if let Some(seconds) = self.retry_after
            && let Ok(value) = header::HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

fn coded(status: StatusCode, error: &'static str, message: String) -> BackupApiError {
    ApiError {
        status,
        error,
        message,
        extra: None,
    }
    .into()
}

fn api_error(error: BackupError) -> BackupApiError {
    match error {
        BackupError::BadRequest(message) => ApiError::bad(message).into(),
        BackupError::NotFound(message) => ApiError::not_found(message).into(),
        BackupError::Conflict(message) => coded(StatusCode::CONFLICT, "conflict", message),
        BackupError::ActiveRun {
            run_id,
            client_run_id,
        } => {
            let mut error = coded(
                StatusCode::CONFLICT,
                "active_run",
                "another run of this agent is still uploading".to_string(),
            );
            error
                .details
                .insert("activeRunId".to_string(), run_id.into());
            error
                .details
                .insert("activeClientRunId".to_string(), client_run_id.into());
            error
        }
        BackupError::ParamsConflict(message) => {
            coded(StatusCode::CONFLICT, "params_conflict", message)
        }
        BackupError::Terminal(message) => coded(StatusCode::CONFLICT, "run_terminal", message),
        BackupError::Unauthorized => coded(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Missing or invalid token.".to_string(),
        ),
        BackupError::Unavailable(message) => BackupApiError {
            retry_after: Some(60),
            ..coded(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
        },
        BackupError::Insufficient(message) => coded(
            StatusCode::INSUFFICIENT_STORAGE,
            "insufficient_storage",
            message,
        ),
        BackupError::TooLarge(message) => {
            coded(StatusCode::PAYLOAD_TOO_LARGE, "too_large", message)
        }
        BackupError::HashMismatch(message) => {
            coded(StatusCode::UNPROCESSABLE_ENTITY, "hash_mismatch", message)
        }
        BackupError::Busy(message) => BackupApiError {
            retry_after: Some(5),
            ..coded(StatusCode::SERVICE_UNAVAILABLE, "busy", message)
        },
        BackupError::Timeout(message) => coded(StatusCode::REQUEST_TIMEOUT, "timeout", message),
        BackupError::Internal(message) => {
            tracing::error!("backup service error: {message}");
            ApiError::server().into()
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

    // Say which credential family was presented instead of a bare 401.
    match crate::auth::token_kind(token) {
        crate::auth::TokenKind::PushAgent => {
            return crate::auth::push_token_on_backup_agent_api();
        }
        crate::auth::TokenKind::Operator => {
            return crate::auth::operator_token_on_agent_api("/api/backup/v1");
        }
        crate::auth::TokenKind::Legacy => {
            match crate::auth::legacy_agent_kind(&state.pool, token).await {
                Ok(Some(crate::auth::TokenKind::PushAgent)) => {
                    return crate::auth::push_token_on_backup_agent_api();
                }
                Ok(_) => match crate::auth::known_operator_token(&state.pool, token).await {
                    Ok(true) => {
                        return crate::auth::operator_token_on_agent_api("/api/backup/v1");
                    }
                    Ok(false) => {}
                    Err(error) => {
                        tracing::error!("backup agent auth: token kind check: {error}");
                        return api_error(BackupError::Unavailable(
                            "credential check is temporarily unavailable".to_string(),
                        ))
                        .into_response();
                    }
                },
                Err(error) => {
                    tracing::error!("backup agent auth: token kind check: {error}");
                    return api_error(BackupError::Unavailable(
                        "credential check is temporarily unavailable".to_string(),
                    ))
                    .into_response();
                }
            }
        }
        crate::auth::TokenKind::BackupAgent | crate::auth::TokenKind::Other => {}
    }

    match backups::agents::authenticate(&state.pool, token).await {
        Ok(Some(agent_id)) => {
            request.extensions_mut().insert(AgentId(agent_id));
            next.run(request).await
        }
        Ok(None) => crate::auth::unauthorized(),
        // A database problem says nothing about the credential. Answering
        // 401 would make the agent stop as if its token were revoked.
        Err(error) => {
            tracing::error!("backup agent auth failed: {error}");
            api_error(BackupError::Unavailable(
                "credential check is temporarily unavailable".to_string(),
            ))
            .into_response()
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
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Response, BackupApiError> {
    let (agent, token) = state
        .backups
        .register_agent(input)
        .await
        .map_err(api_error)?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "ok": true,
            "agent": agent,
            // Shown once. This credential opens /api/backup/v1 only; it is
            // not an operator token and not a host-agent push token.
            "token": token,
            "tokenKind": "backup_agent",
            "tokenPrefix": crate::auth::BACKUP_TOKEN_PREFIX,
            "usage": "Authorization: Bearer flatline_agent_backup_... on /api/backup/v1",
            "warning": "Do not paste this into the dashboard or use it on /api/v1; the API rejects it with backup_agent_token_on_metric_agent_api on agent routes and agent_token_on_operator_api elsewhere."
        })),
    )
        .into_response())
}

/// PATCH /api/v1/backup-agents/{id}
pub async fn patch_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(patch): Json<AgentPatch>,
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Json<serde_json::Value>, BackupApiError> {
    let (agent, token) = state.backups.rotate_token(&id).await.map_err(api_error)?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "agent": agent,
        "token": token,
        "tokenKind": "backup_agent",
        "tokenPrefix": crate::auth::BACKUP_TOKEN_PREFIX,
        "usage": "Authorization: Bearer flatline_agent_backup_... on /api/backup/v1",
    })))
}

/// POST /api/v1/backup-agents/{id}/revoke-token
pub async fn revoke_token(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, BackupApiError> {
    let agent = state.backups.revoke_token(&id).await.map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "agent": agent })))
}

/// GET /api/v1/backup-agents/{id}/runs
pub async fn list_runs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<RunListQuery>,
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Json<serde_json::Value>, BackupApiError> {
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

/// POST /api/backup/v1/runs/{id}/abandon (agent-scoped)
pub async fn agent_abandon(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, BackupApiError> {
    let run = state
        .backups
        .abandon_run(&agent_id, &id)
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "run": run })))
}

/// POST /api/backup/v1/runs/{id}/complete (agent-scoped)
pub async fn agent_complete(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, BackupApiError> {
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
) -> Result<Response, BackupApiError> {
    let bundle = state.backups.open_bundle(&id).await.map_err(api_error)?;
    stream_bundle(bundle)
}

/// POST /api/v1/backup-runs/{id}/download-ticket
///
/// Operator only. Returns a single-use URL valid for about two minutes so a
/// browser can save the bundle with a plain streamed GET.
pub async fn download_ticket(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, BackupApiError> {
    let ticket = state
        .backups
        .issue_download_ticket(&id)
        .await
        .map_err(api_error)?;
    let body = serde_json::json!({
        "ok": true,
        "runId": ticket.run_id,
        "url": format!("/api/v1/backup-downloads/{}", ticket.ticket),
        "expiresAt": ticket.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    Ok(([(CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

/// GET /api/v1/backup-downloads/{ticket}
pub async fn download_by_ticket(
    State(state): State<AppState>,
    Path(ticket): Path<String>,
) -> Result<Response, BackupApiError> {
    let bundle = state
        .backups
        .redeem_download_ticket(&ticket)
        .await
        .map_err(api_error)?;
    stream_bundle(bundle)
}

fn stream_bundle(bundle: backups::BundleDownload) -> Result<Response, BackupApiError> {
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
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::from_stream(stream))
        .map_err(|_| ApiError::server().into())
}

/// POST /api/backup/v1/failures (agent-scoped)
pub async fn agent_failure(
    State(state): State<AppState>,
    axum::Extension(AgentId(agent_id)): axum::Extension<AgentId>,
    Json(input): Json<FailureReport>,
) -> Result<Json<serde_json::Value>, BackupApiError> {
    let run = state
        .backups
        .report_failure(&agent_id, input)
        .await
        .map_err(api_error)?;
    Ok(Json(serde_json::json!({ "ok": true, "run": run })))
}
