//! Sign-in compatibility for the reused SPA.
//!
//! The operator's model is "one token signs you in": there are no accounts,
//! invites or TOTP. The existing login form posts `{username, password}`;
//! the token is accepted in the password field, so the frontend needs no
//! change. `/auth/setup` always reports "no setup needed" and `/auth/me`
//! describes the token.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::auth;

/// GET /api/v1/auth/setup — public.
pub async fn setup_status() -> Json<Value> {
    Json(json!({ "ok": true, "setupNeeded": false }))
}

/// POST /api/v1/auth/login — public.
///
/// Accepts the token as the password; the username is ignored. Returns the
/// same token so the SPA can store it exactly like the old login flow.
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let password = body
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    match auth::verify_token(&state.pool, &password).await {
        Ok(true) => Ok(Json(json!({
            "ok": true,
            "token": password,
            "user": { "id": "token", "username": null, "name": "Operator" },
        }))
        .into_response()),
        Ok(false) => Err(ApiError {
            status: axum::http::StatusCode::UNAUTHORIZED,
            error: "unauthorized",
            message: "That token is not valid.".to_string(),
        }),
        // A busy database is not a wrong token: 503 (or 429), never 401.
        Err(error) => Ok(auth::verify_error_response(&error)),
    }
}

/// GET /api/v1/auth/me — token-authenticated.
///
/// Mounted behind `require_token`, which already verified the bearer token;
/// verifying it again here would only repeat the work.
pub async fn me() -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "ok": true,
        "user": { "id": "token", "username": null, "name": "Operator" },
        "scopes": [ "read", "write" ],
    })))
}
