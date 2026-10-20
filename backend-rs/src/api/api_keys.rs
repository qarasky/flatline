//! API keys for the Agents panel.
//!
//! One token table, no users and no scopes (locked scope): every key is a
//! full-permission bearer credential. Plaintext is shown exactly once at
//! mint time; only the SHA-256 hash is stored.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::auth::{OP_TOKEN_PREFIX, hash_token, mint_op_token};
use crate::metrics::metric_time;

type TokenRow = (i64, String, String, Option<String>, i64);

/// Scopes the panel may show. The Rust backend has one scope: full.
const SCOPES: [&str; 1] = ["full"];

fn api_key_json(
    id: i64,
    name: &str,
    created: &str,
    expires: &Option<String>,
    active: i64,
) -> Value {
    let expired = expires
        .as_deref()
        .and_then(metric_time)
        .is_some_and(|at| at < chrono::Utc::now().timestamp_millis());
    let status = if expired {
        "expired"
    } else if active == 0 {
        "inactive"
    } else {
        "active"
    };

    json!({
        "id": id,
        "name": name,
        "userID": "",
        "createdDate": created,
        "active": active != 0,
        "expires": expires,
        "status": status,
        "scopes": SCOPES,
    })
}

/// GET /api/v1/api-keys
pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows: Vec<TokenRow> =
        sqlx::query_as("SELECT id, name, created_at, expires, active FROM tokens ORDER BY id")
            .fetch_all(&state.pool)
            .await
            .map_err(internal)?;

    Ok(Json(json!({
        "ok": true,
        "count": rows.len(),
        "apiKeys": rows
            .iter()
            .map(|(id, name, created, expires, active)| api_key_json(*id, name, created, expires, *active))
            .collect::<Vec<_>>(),
        "availableScopes": SCOPES,
        "tokenKind": "operator",
        "tokenPrefix": OP_TOKEN_PREFIX,
        "note": "This list contains operator tokens only. Agent credentials are shown on their monitor (push) or backup-agent registration (backup).",
    })))
}

/// POST /api/v1/api-keys
pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let payload = body
        .as_object()
        .ok_or_else(|| ApiError::bad("body must be a JSON object"))?;

    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ApiError::bad("`name` is required."))?
        .chars()
        .take(255)
        .collect::<String>();
    let active = payload
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let expires = payload
        .get("expires")
        .and_then(Value::as_str)
        .filter(|expires| !expires.is_empty())
        .map(str::to_string);

    let token = mint_op_token();
    let row: (i64, String, String, Option<String>, i64) = sqlx::query_as(
        "INSERT INTO tokens (name, hash, scheme, active, expires)
         VALUES (?, ?, 'sha256', ?, ?)
         RETURNING id, name, created_at, expires, active",
    )
    .bind(&name)
    .bind(hash_token(&token))
    .bind(if active { 1 } else { 0 })
    .bind(&expires)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;

    state.events.invalidate();
    tracing::info!("api-keys: minted key {} ({name})", row.0);

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "apiKey": api_key_json(row.0, &row.1, &row.2, &row.3, row.4),
            // Shown once. There is no endpoint that returns this again.
            "token": token,
            "tokenKind": "operator",
            "tokenPrefix": OP_TOKEN_PREFIX,
            "usage": {
                "gui": "Paste the full token into the sign-in form.",
                "api": "Authorization: Bearer flatline_op_...",
            },
            "warning": "This token can manage the whole instance. Do not give it to a host agent: agents use flatline_agent_push_... minted with their monitor.",
        })),
    ))
}

/// PATCH /api/v1/api-keys/{id}
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let Some(active) = body.get("active").and_then(Value::as_bool) else {
        return Err(ApiError::bad("`active` (true/false) is required."));
    };

    let result = sqlx::query("UPDATE tokens SET active = ? WHERE id = ?")
        .bind(if active { 1 } else { 0 })
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("No API key with id {id}.")));
    }

    let row: TokenRow =
        sqlx::query_as("SELECT id, name, created_at, expires, active FROM tokens WHERE id = ?")
            .bind(id)
            .fetch_one(&state.pool)
            .await
            .map_err(internal)?;

    state.events.invalidate();

    Ok(Json(json!({
        "ok": true,
        "apiKey": api_key_json(row.0, &row.1, &row.2, &row.3, row.4),
    })))
}

/// DELETE /api/v1/api-keys/{id}
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let result = sqlx::query("DELETE FROM tokens WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!("No API key with id {id}.")));
    }

    state.events.invalidate();
    tracing::info!("api-keys: revoked key {id}");

    Ok(Json(json!({ "ok": true, "deleted": id })))
}

fn internal(error: sqlx::Error) -> ApiError {
    tracing::error!("api-keys api: {error}");
    ApiError::server()
}
