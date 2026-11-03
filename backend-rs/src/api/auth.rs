//! Kore ID sign-in, sign-out and the session cookie.
//!
//! People sign in only through Kore ID (`GET /api/v1/auth/sso/start`). The
//! callback creates a server-side session behind the `fl_session` cookie
//! (see [`crate::sessions`]); `/auth/me` says who is signed in. Operator API
//! tokens never create a browser session: they authenticate `/api/v1` as
//! `Authorization: Bearer`.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{Value, json};

use crate::AppState;
use crate::accounts;
use crate::api::ApiError;
use crate::auth::{self, Authed, Principal};
use crate::sessions;

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
/// Says who is signed in (`principal`: an `account` from a Kore ID session,
/// or the `token` behind a bearer header) and what the credential may do, so
/// an agent does not have to infer it from OpenAPI.
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
        Principal::Account { user_id } => {
            let account = accounts::get(&state.pool, user_id).await?;
            body["principal"] = json!("account");
            body["account"] = json!({
                "id": account.id,
                "email": account.email,
                "name": account.name,
                "sso": account.kore_sub.is_some(),
            });
            body["user"] =
                json!({ "id": account.id, "username": account.email, "name": account.name });
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
    ApiError::server()
}

/// GET /api/v1/auth/sso/config — public. What the sign-in page offers, and
/// for the account menu the Kore ID account page and the other Kore apps.
pub async fn sso_config(State(state): State<AppState>) -> Json<Value> {
    let kore = state.sso.as_ref().map(|sso| &sso.config);
    let apps: serde_json::Map<String, Value> = kore
        .map(|k| {
            k.app_urls
                .iter()
                .map(|(app, url)| (app.clone(), json!(url)))
                .collect()
        })
        .unwrap_or_default();
    Json(json!({
        "ok": true,
        "sso": state.sso.is_some(),
        "provider": "Kore ID",
        "accountUrl": kore.map(|k| k.account_url.clone()),
        "apps": apps,
    }))
}

fn sso_redirect(location: &str, cookies: &[String]) -> Response {
    let mut response = (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, location.to_string())],
    )
        .into_response();
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
    let session = match sessions::create(&state.pool, account.id).await {
        Ok(session) => session,
        Err(error) => {
            tracing::error!("sso: session: {error}");
            return sso_failed("unavailable", secure);
        }
    };
    if let Err(error) = sessions::set_sso_details(
        &state.pool,
        &session,
        &identity.id_token,
        identity.claims.sid.as_deref(),
    )
    .await
    {
        tracing::error!("sso: could not keep the id token and sid: {error}");
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

/// POST /api/v1/auth/sso/backchannel-logout — public; Kore ID calls it
/// (OIDC Back-Channel Logout 1.0) with a form-encoded `logout_token` when a
/// Kore ID session ends. A verified token deletes the local sessions made
/// from that Kore ID session (or, without `sid`, every Kore ID session of
/// that `sub`): 200. A missing or invalid token: 400. The provider's keys
/// out of reach: 503, so Kore ID retries.
pub async fn sso_backchannel_logout(State(state): State<AppState>, body: String) -> Response {
    let no_store = || [(header::CACHE_CONTROL, "no-store")];
    let invalid = |description: &str| {
        (
            StatusCode::BAD_REQUEST,
            no_store(),
            Json(json!({ "error": "invalid_request", "error_description": description })),
        )
            .into_response()
    };
    let Some(sso) = &state.sso else {
        return invalid("Kore ID sign-in is not configured here.");
    };
    let token = url::form_urlencoded::parse(body.as_bytes())
        .find(|(name, _)| name == "logout_token")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty());
    let Some(token) = token else {
        return invalid("logout_token is required.");
    };
    let target = match sso.verify_logout_token(&token).await {
        Ok(target) => target,
        Err(crate::sso::SsoError::Unavailable(why)) => {
            tracing::warn!("sso: back-channel logout could not reach the provider: {why}");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                no_store(),
                Json(json!({ "error": "temporarily_unavailable" })),
            )
                .into_response();
        }
        Err(error) => {
            tracing::warn!("sso: back-channel logout refused: {error:?}");
            return invalid("The logout token did not verify.");
        }
    };
    match sessions::end_for_kore_logout(&state.pool, &target).await {
        Ok(ended) => {
            tracing::info!("sso: back-channel logout ended {ended} session(s)");
            (StatusCode::OK, no_store(), Json(json!({ "ok": true }))).into_response()
        }
        Err(error) => {
            tracing::error!("sso: back-channel logout: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                no_store(),
                Json(json!({ "error": "server_error" })),
            )
                .into_response()
        }
    }
}
