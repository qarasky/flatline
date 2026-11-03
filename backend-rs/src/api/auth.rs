//! Sign-in.
//!
//! The web app signs a browser in with `POST /auth/session`: an email and
//! password (a member account) or an operator token. Either way the cookie
//! carries a server-side session id (see [`crate::sessions`]). The old
//! dashboard's `POST /auth/login` still takes a token in the password field
//! and hands it back. `/auth/me` says who is signed in.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::{Extension, Json};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::auth::{self, Authed, Principal};
use crate::sessions::{self, SessionOwner};
use crate::{accounts, api};

/// GET /api/v1/auth/setup — public. `setupNeeded` is true while no account
/// exists: the sign-in page then offers "Create the first account".
pub async fn setup_status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let accounts = accounts::count(&state.pool).await?;
    Ok(Json(json!({ "ok": true, "setupNeeded": accounts == 0 })))
}

/// POST /api/v1/auth/setup — public. Body `{token, email, name, password}`.
///
/// Creates the first account and signs it in. Needs a valid operator token
/// (any: every operator token has the same authority), so a stranger who
/// reaches a fresh install cannot claim it. Once any account exists this
/// answers 409 `setup_done`; further accounts are added from Members.
pub async fn setup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    if !state.config.local_login {
        return Err(local_login_disabled());
    }
    let setup_done = || {
        ApiError::new(
            StatusCode::CONFLICT,
            "setup_done",
            "An account already exists.",
        )
        .with_hint("Sign in, then add people from Members (`POST /api/v1/users`).")
    };
    if accounts::count(&state.pool).await? > 0 {
        return Err(setup_done());
    }
    let text = |name: &str| body.get(name).and_then(Value::as_str).unwrap_or_default();
    match auth::verify_token(&state.pool, text("token").trim()).await {
        Ok(auth::TokenVerdict::Operator(_)) => {}
        Ok(auth::TokenVerdict::Agent(kind)) => return Ok(auth::agent_token_on_operator_api(kind)),
        Ok(auth::TokenVerdict::Invalid) => return Ok(auth::unauthorized()),
        Err(error) => return Ok(auth::verify_error_response(&error)),
    }
    let Some(account) =
        accounts::create_first(&state.pool, text("email"), text("name"), text("password")).await?
    else {
        return Err(setup_done());
    };
    tracing::info!("auth: created the first account {}", account.id);
    signed_in(
        &state,
        &headers,
        SessionOwner::Account(account.id),
        json!({ "ok": true, "principal": "account", "user": account.to_json() }),
    )
    .await
}

/// POST /api/v1/auth/password — the signed-in account chooses a new password.
///
/// Body `{currentPassword, newPassword}`. Only an account session has a
/// password (a bearer token or token session answers 400 `not_an_account`).
/// Success clears "must change password" and ends the account's other
/// sessions; this one stays signed in.
pub async fn change_password(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let Principal::Account { user_id, .. } = authed.principal else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "not_an_account",
            "Only an account has a password to change.",
        )
        .with_hint("This request was signed in with an operator token. Sign in with an email and password, or reset a member's password with `POST /api/v1/users/{id}/reset-password`."));
    };
    let text = |name: &str| body.get(name).and_then(Value::as_str).unwrap_or_default();
    // A session opened before the starting password expired does not
    // outlive it: the same rule as at sign-in.
    if accounts::get(&state.pool, user_id).await?.starting_password_expired() {
        return Err(starting_password_expired());
    }
    if !accounts::password_matches(&state.pool, user_id, text("currentPassword")).await? {
        // Not 401: the session is fine, only the typed password is wrong.
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "wrong_password",
            "The current password is wrong.",
        )
        .with_hint("Type the password you signed in with."));
    }
    if text("newPassword") == text("currentPassword") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "same_password",
            "Choose a password different from the current one.",
        )
        .with_hint("A starting password was chosen by someone else; pick one only you know."));
    }
    accounts::set_password(&state.pool, user_id, text("newPassword"), false).await?;
    let keep = match &authed.credential {
        auth::Credential::Session(session) => Some(session.as_str()),
        auth::Credential::Bearer(_) => None,
    };
    sessions::end_for_account(&state.pool, user_id, keep)
        .await
        .map_err(internal)?;
    tracing::info!("auth: account {user_id} changed its password");
    Ok(Json(json!({ "ok": true })))
}

/// The 429 for a limited sign-in, with how long to wait (the same shape as
/// the token store's 429).
fn rate_limited(wait: u64) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, wait.to_string())],
        Json(json!({
            "ok": false,
            "error": "rate_limited",
            "code": "rate_limited",
            "message": format!("Too many failed sign-ins. Try again in {} minutes.", wait.div_ceil(60)),
            "retryAfterSeconds": wait,
            "hint": "Wait `retryAfterSeconds`, then try again. A forgotten password can be reset by anyone signed in, from Members.",
        })),
    )
        .into_response()
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
    if !state.config.token_login {
        return Err(token_login_disabled());
    }
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

/// The answer when a starting password is past its expiry.
fn starting_password_expired() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "starting_password_expired",
        "Ask someone to reset your password.",
    )
    .with_hint(format!("A starting password expires {} days after it was set. Anyone signed in can set a new one from Members.", accounts::STARTING_PASSWORD_DAYS))
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
        if !state.config.local_login {
            return Err(local_login_disabled());
        }
        let email = text("email");
        let password = text("password");
        let email_key = accounts::email_key(&email);
        let address = auth::client_address(&headers);
        if let Err(wait) = state.sign_ins.reserve(&email_key, &address) {
            return Ok(rate_limited(wait));
        }
        // An error leaves the attempt counted, as a wrong password does.
        let Some(account) = accounts::verify_password(&state.pool, &email, &password).await?
        else {
            return Err(wrong_email_or_password());
        };
        state.sign_ins.succeeded(&email_key, &address);
        // Checked only once the password matched, so the reason reveals
        // nothing to someone guessing.
        if account.starting_password_expired() {
            return Err(starting_password_expired());
        }
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

    if !state.config.token_login {
        return Err(token_login_disabled());
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
    let mut body = json!({ "ok": true });
    if let Some(session) = auth::session_id(&headers) {
        // A Kore ID session also ends at the provider: hand the browser the
        // end-session URL (the id token is the hint) to follow.
        if let Some(sso) = &state.sso
            && let Ok(Some(id_token)) = sessions::sso_id_token(&state.pool, &session).await
            && let Some(url) = sso.logout_url(&id_token).await
        {
            body["ssoLogoutUrl"] = json!(url);
        }
        if let Err(error) = sessions::end(&state.pool, &session).await {
            tracing::error!("sign-out: {error}");
        }
    }
    let cookie = auth::clear_session_cookie(auth::request_is_https(&headers));
    ([(header::SET_COOKIE, cookie)], Json(body)).into_response()
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

fn local_login_disabled() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "local_login_disabled",
        "Email and password sign-in is turned off on this instance.",
    )
    .with_hint("Sign in with Kore ID (`GET /api/v1/auth/sso/start`).")
}

fn token_login_disabled() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "token_login_disabled",
        "Signing in with an operator token is turned off on this instance.",
    )
    .with_hint("Operator tokens still work as `Authorization: Bearer` on /api/v1. Sign in with Kore ID in the browser.")
}

/// GET /api/v1/auth/sso/config — public. What the sign-in page offers.
pub async fn sso_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "sso": state.sso.is_some(),
        "provider": "Kore ID",
        "localLogin": state.config.local_login,
        "tokenLogin": state.config.token_login,
    }))
}

fn sso_redirect(location: &str, cookies: &[String]) -> Response {
    let mut response = (StatusCode::SEE_OTHER, [(header::LOCATION, location.to_string())]).into_response();
    for cookie in cookies {
        if let Ok(value) = axum::http::HeaderValue::from_str(cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

fn sso_failed(code: &str, secure: bool) -> Response {
    sso_redirect(
        &format!("/sign-in?sso_error={code}"),
        &[crate::sso::clear_binding_cookie(secure)],
    )
}

/// GET /api/v1/auth/sso/start?next=/path — public. Redirects the browser to
/// Kore ID. `next` is a local path to land on afterwards.
pub async fn sso_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let secure = auth::request_is_https(&headers);
    let Some(sso) = &state.sso else {
        return sso_failed("disabled", secure);
    };
    match sso.start(params.get("next").map(String::as_str)).await {
        Ok((url, binding)) => sso_redirect(&url, &[crate::sso::binding_cookie(&binding, secure)]),
        Err(error) => {
            tracing::warn!("sso: could not start: {error:?}");
            sso_failed(error.code(), secure)
        }
    }
}

/// GET /api/v1/auth/sso/callback — public. Kore ID returns the browser here
/// with `code` and `state` (or `error`). On success the response sets the
/// `fl_session` cookie and redirects to the page the person came for; on
/// any failure it redirects to `/sign-in?sso_error=<code>` and sets no
/// session.
pub async fn sso_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let secure = auth::request_is_https(&headers);
    let Some(sso) = &state.sso else {
        return sso_failed("disabled", secure);
    };
    let fail = |error: crate::sso::SsoError| {
        tracing::warn!("sso: sign-in failed: {error:?}");
        sso_failed(error.code(), secure)
    };
    if let Some(error) = params.get("error") {
        return fail(crate::sso::SsoError::Provider(error.clone()));
    }
    // RFC 9207: a response from another issuer is not ours.
    if let Some(iss) = params.get("iss")
        && iss.trim_end_matches('/') != sso.config.issuer
    {
        return fail(crate::sso::SsoError::State);
    }
    let (Some(code), Some(state_param)) = (params.get("code"), params.get("state")) else {
        return fail(crate::sso::SsoError::State);
    };
    let binding = crate::status_pages::parse_cookies(&headers).remove(crate::sso::SSO_COOKIE);
    let identity = match sso.finish(code, state_param, binding.as_deref()).await {
        Ok(identity) => identity,
        Err(error) => return fail(error),
    };
    let account = match accounts::sso_sign_in(&state.pool, &sso.config, &identity.claims).await {
        Ok(Ok(account)) => account,
        Ok(Err(denied)) => {
            tracing::warn!("sso: {} denied: {denied:?}", identity.claims.sub);
            return sso_failed("denied", secure);
        }
        Err(error) => {
            tracing::error!("sso: account: {error:?}");
            return sso_failed("unavailable", secure);
        }
    };
    let session = match sessions::create(&state.pool, SessionOwner::Account(account.id)).await {
        Ok(session) => session,
        Err(error) => {
            tracing::error!("sso: session: {error}");
            return sso_failed("unavailable", secure);
        }
    };
    if let Err(error) = sessions::set_sso_id_token(&state.pool, &session, &identity.id_token).await {
        tracing::error!("sso: could not keep the id token: {error}");
    }
    tracing::info!("auth: account {} signed in with Kore ID", account.id);
    sso_redirect(
        &identity.next,
        &[
            auth::session_cookie(&session, secure),
            crate::sso::clear_binding_cookie(secure),
        ],
    )
}
