//! Members: the accounts people sign in with.
//!
//! Anyone signed in (an account, a token session or a bearer token) may add,
//! edit, reset and remove accounts: every account has full permission.
//! Passwords never appear in a response.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::AppState;
use crate::accounts::{self, Account};
use crate::api::ApiError;

fn field<'a>(body: &'a Value, name: &str) -> Option<&'a str> {
    body.get(name).and_then(Value::as_str)
}

fn required<'a>(body: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    field(body, name).ok_or_else(|| ApiError::bad(format!("`{name}` is required.")))
}

fn internal(error: sqlx::Error) -> ApiError {
    tracing::error!("users api: {error}");
    ApiError::server()
}

/// Account JSON plus how many tokens the account made.
fn member_json(account: &Account, token_count: i64) -> Value {
    let mut value = account.to_json();
    value["tokenCount"] = json!(token_count);
    value
}

/// GET /api/v1/users
pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let accounts = accounts::list(&state.pool).await?;
    let counts: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT maker_user_id, COUNT(*) FROM tokens
         WHERE maker_user_id IS NOT NULL GROUP BY maker_user_id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    let count_for = |id: i64| {
        counts
            .iter()
            .find(|(maker, _)| *maker == id)
            .map_or(0, |(_, count)| *count)
    };
    let users: Vec<Value> = accounts
        .iter()
        .map(|account| member_json(account, count_for(account.id)))
        .collect();
    Ok(Json(json!({ "ok": true, "count": users.len(), "users": users })))
}

/// POST /api/v1/users — `{email, name, password}`; the password is a
/// starting password the member must change at first sign-in.
pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let email = required(&body, "email")?;
    let name = required(&body, "name")?;
    let password = required(&body, "password")?;
    let account = accounts::create(&state.pool, email, name, password, true).await?;
    tracing::info!("users: added account {}", account.id);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "user": member_json(&account, 0) })),
    ))
}

/// GET /api/v1/users/{id} — the account and the tokens it made.
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let account = accounts::get(&state.pool, id).await?;
    let tokens: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, name, active FROM tokens WHERE maker_user_id = ? ORDER BY id",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;
    let tokens: Vec<Value> = tokens
        .iter()
        .map(|(id, name, active)| json!({ "id": id, "name": name, "active": *active != 0 }))
        .collect();
    Ok(Json(json!({
        "ok": true,
        "user": member_json(&account, tokens.len() as i64),
        "tokens": tokens,
    })))
}

/// PATCH /api/v1/users/{id} — `{name?, email?}`.
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !body.is_object() {
        return Err(ApiError::bad("body must be a JSON object"));
    }
    let name = field(&body, "name");
    let email = field(&body, "email");
    if name.is_none() && email.is_none() {
        return Err(ApiError::bad("Send `name`, `email` or both."));
    }
    let account = accounts::update(&state.pool, id, name, email).await?;
    Ok(Json(json!({ "ok": true, "user": account.to_json() })))
}

/// POST /api/v1/users/{id}/reset-password — `{password}`: a new starting
/// password the member must change at their next sign-in. Ends every
/// session the account has.
pub async fn reset_password(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let password = required(&body, "password")?;
    let account = accounts::set_password(&state.pool, id, password, true).await?;
    // Whoever was signed in as them signs in again, with the new password.
    crate::sessions::end_for_account(&state.pool, id, None)
        .await
        .map_err(internal)?;
    tracing::info!("users: reset the password of account {id}");
    Ok(Json(json!({ "ok": true, "user": account.to_json() })))
}
