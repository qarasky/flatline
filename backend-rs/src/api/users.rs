//! Members: the accounts people sign in with.
//!
//! Anyone signed in (an account, a token session or a bearer token) may add,
//! edit, reset and remove accounts: every account has full permission.
//! Passwords never appear in a response.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde_json::{Value, json};

use crate::AppState;
use crate::accounts::{self, Account};
use crate::api::ApiError;
use crate::auth::{Authed, Principal};

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

/// DELETE /api/v1/users/{id} — optional body `{revokeTokenIds: [id, ...]}`.
///
/// Removes the account (its sessions go with it) and disables the tokens
/// listed, each of which must be one this account made; tokens not listed
/// keep working and keep the maker's name. Nobody removes their own account
/// (409 `cannot_remove_self`). Removing the last account is allowed: token
/// sign-in always remains.
pub async fn delete(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
    Path(id): Path<i64>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let body: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| ApiError::bad("The body must be JSON: `{\"revokeTokenIds\": [...]}`."))?
    };
    let mut revoke: Vec<i64> = match body.get("revokeTokenIds") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| id.as_i64())
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| ApiError::bad("`revokeTokenIds` must be an array of token ids."))?,
        Some(_) => return Err(ApiError::bad("`revokeTokenIds` must be an array of token ids.")),
    };
    revoke.sort_unstable();
    revoke.dedup();

    if let Principal::Account { user_id, .. } = authed.principal
        && user_id == id
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "cannot_remove_self",
            "You cannot remove your own account.",
        )
        .with_hint("Ask someone else who is signed in to remove it."));
    }
    let account = accounts::get(&state.pool, id).await?;

    let mut tx = state.pool.begin().await.map_err(internal)?;
    for token_id in &revoke {
        let maker: Option<Option<i64>> =
            sqlx::query_scalar("SELECT maker_user_id FROM tokens WHERE id = ?")
                .bind(token_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?;
        if maker != Some(Some(id)) {
            return Err(ApiError::bad(format!(
                "Token {token_id} was not made by this member; only their own tokens can be revoked with them."
            ))
            .with_hint("Read `GET /api/v1/users/{id}` for the tokens this member made. Revoke other tokens from `/api/v1/api-keys`."));
        }
        sqlx::query("UPDATE tokens SET active = 0 WHERE id = ?")
            .bind(token_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("DELETE FROM sessions WHERE token_id = ?")
            .bind(token_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    // Kept tokens keep the maker's latest name once the account is gone.
    sqlx::query("UPDATE tokens SET maker_name = ? WHERE maker_user_id = ?")
        .bind(&account.name)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;

    state.events.invalidate();
    tracing::info!(
        "users: removed account {id}, revoked {} of its tokens",
        revoke.len()
    );
    Ok(Json(json!({ "ok": true, "deleted": id, "revokedTokens": revoke.len() })))
}
