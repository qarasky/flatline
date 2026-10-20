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
/// An agent credential is rejected with an explicit message instead of a
/// generic 401: the GUI is not the place for a push or backup token.
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
        Ok(auth::TokenVerdict::Operator) => Ok(Json(json!({
            "ok": true,
            "token": password,
            "tokenKind": "operator",
            "tokenPrefix": auth::OP_TOKEN_PREFIX,
            "capabilities": [
                "gui",
                "operator_api",
                "manage_monitors",
                "manage_notifications",
                "manage_agents",
                "mint_operator_tokens"
            ],
            "user": { "id": "token", "username": null, "name": "Operator" },
        }))
        .into_response()),
        Ok(auth::TokenVerdict::Agent(kind)) => Ok(auth::agent_token_on_operator_api(kind)),
        Ok(auth::TokenVerdict::Invalid) => Err(ApiError {
            status: axum::http::StatusCode::UNAUTHORIZED,
            error: "unauthorized",
            message: "That token is not valid.".to_string(),
            extra: Some(Box::new(crate::api::ApiErrorExtra {
                hint: Some(
                    "Operator tokens start with `flatline_op_`. Legacy `flatline_...` tokens still work. An agent token (`flatline_agent_...`) is rejected here by design."
                        .to_string(),
                ),
                details: None,
            })),
        }),
        // A busy database is not a wrong token: 503 (or 429), never 401.
        Err(error) => Ok(auth::verify_error_response(&error)),
    }
}

/// GET /api/v1/auth/me — token-authenticated.
///
/// Mounted behind `require_token`, which already verified the bearer token;
/// verifying it again here would only repeat the work. The response states
/// the credential kind and what it may do, so an agent does not have to
/// infer it from OpenAPI.
pub async fn me() -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "ok": true,
        "tokenKind": "operator",
        "tokenPrefix": auth::OP_TOKEN_PREFIX,
        "capabilities": [
            "gui",
            "operator_api",
            "manage_monitors",
            "manage_notifications",
            "manage_agents",
            "mint_operator_tokens"
        ],
        "agentTokenAccess": {
            "pushEndpoint": "/api/push/{pushToken}",
            "downloads": "/agent/*",
            "backupAgentApi": "/api/backup/v1"
        },
        "user": { "id": "token", "username": null, "name": "Operator" },
        "scopes": [ "read", "write" ],
    })))
}
