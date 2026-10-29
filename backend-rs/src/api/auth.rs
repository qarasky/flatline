//! Sign-in.
//!
//! The web app signs a browser in with `POST /auth/session`: an email and
//! password (a member account) or an operator token. Either way the cookie
//! carries a server-side session id (see [`crate::sessions`]). The old
//! dashboard's `POST /auth/login` still takes a token in the password field
//! and hands it back. `/auth/me` says who is signed in.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::{Extension, Json};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::auth::{self, Authed, Principal};
use crate::sessions::{self, SessionOwner};
use crate::{accounts, api};

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
        Ok(auth::TokenVerdict::Operator(_)) => Ok(Json(json!({
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

/// The answer to a failed email/password sign-in. Identical for an unknown
/// email and a wrong password, so the form does not reveal which emails
/// exist.
fn wrong_email_or_password() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "Wrong email or password.",
    )
    .with_hint("Check both and try again. Someone signed in can reset a forgotten password from Members; an operator token still signs in through \"Use a token instead\".")
}

/// Start a session for `owner` and answer with its cookie.
async fn signed_in(
    state: &AppState,
    headers: &HeaderMap,
    owner: SessionOwner,
    body: Value,
) -> Result<Response, ApiError> {
    let session = sessions::create(&state.pool, owner)
        .await
        .map_err(internal)?;
    let cookie = auth::session_cookie(&session, auth::request_is_https(headers));
    Ok(([(header::SET_COOKIE, cookie)], Json(body)).into_response())
}

/// POST /api/v1/auth/session — public, beside `login`.
///
/// Body `{email, password}` signs a member in; body `{token}` signs in with
/// an operator token (the wall TV, recovery). On success the `HttpOnly`
/// cookie carries a new session id. A failure never sets a cookie; a token
/// failure answers as `login` does.
pub async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let text = |name: &str| {
        body.get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    if body.get("email").is_some() {
        let email = text("email");
        let password = text("password");
        let Some(account) = accounts::verify_password(&state.pool, &email, &password).await?
        else {
            return Err(wrong_email_or_password());
        };
        return signed_in(
            &state,
            &headers,
            SessionOwner::Account(account.id),
            json!({
                "ok": true,
                "principal": "account",
                "mustChangePassword": account.must_change_password,
            }),
        )
        .await;
    }

    let token = text("token").trim().to_string();
    match auth::verify_token(&state.pool, &token).await {
        Ok(auth::TokenVerdict::Operator(token_id)) => {
            signed_in(
                &state,
                &headers,
                SessionOwner::Token(token_id),
                json!({ "ok": true, "principal": "token", "tokenKind": "operator" }),
            )
            .await
        }
        // Answers exactly as `login` does for anything but a valid token.
        _ => login(State(state), Json(json!({ "password": token }))).await,
    }
}

/// DELETE /api/v1/auth/session — public: signing out works with a missing
/// or already-ended session. Ends the session server-side and clears the
/// cookie.
pub async fn delete_session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(session) = auth::session_id(&headers)
        && let Err(error) = sessions::end(&state.pool, &session).await
    {
        tracing::error!("sign-out: {error}");
    }
    let cookie = auth::clear_session_cookie(auth::request_is_https(&headers));
    ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response()
}

/// GET /api/v1/auth/me — authenticated.
///
/// Says who is signed in (`principal`: an `account`, or the `token` behind
/// a bearer header or token session) and what the credential may do, so an
/// agent does not have to infer it from OpenAPI.
pub async fn me(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
) -> Result<Json<Value>, ApiError> {
    let mut body = json!({
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
        "scopes": [ "read", "write" ],
    });
    match authed.principal {
        Principal::Account { user_id, .. } => {
            let account = accounts::get(&state.pool, user_id).await?;
            body["principal"] = json!("account");
            body["account"] = json!({
                "id": account.id,
                "email": account.email,
                "name": account.name,
                "mustChangePassword": account.must_change_password,
            });
            body["user"] = json!({ "id": account.id, "username": account.email, "name": account.name });
        }
        Principal::Token { token_id } => {
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM tokens WHERE id = ?")
                .bind(token_id)
                .fetch_optional(&state.pool)
                .await
                .map_err(internal)?;
            let name = name.ok_or_else(|| ApiError::not_found("The token was removed."))?;
            body["principal"] = json!("token");
            body["token"] = json!({ "id": token_id, "name": name });
            body["user"] = json!({ "id": "token", "username": null, "name": "Operator" });
        }
    }
    Ok(Json(body))
}

fn internal(error: sqlx::Error) -> ApiError {
    tracing::error!("auth api: {error}");
    api::ApiError::server()
}
