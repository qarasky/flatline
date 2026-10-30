//! Sign in with a QR code.
//!
//! `start` and `poll` are public: the screen has no session yet. `lookup`,
//! `approve` and `deny` need a signed-in phone. Codes travel in JSON bodies,
//! never in paths or query strings, so they stay out of access logs. The
//! token is minted on the first `poll` after approval, not on approval, so a
//! response that never arrives cannot leave an unclaimed token that never
//! expires behind.

use axum::extract::State;
use axum::{Extension, Json};
use axum::http::{HeaderMap, StatusCode, header};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::auth::{Authed, hash_token, mint_op_token};
use crate::device::{DeviceError, PollOutcome};

/// Serialises first deliveries, so two simultaneous polls of one approved
/// request cannot mint two tokens.
static DELIVERY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn field<'a>(body: &'a Value, name: &str) -> &'a str {
    body.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn device_error(error: DeviceError) -> ApiError {
    match error {
        DeviceError::Full => ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "busy",
            "Too many screens are waiting to sign in.",
        )
        .with_hint(
            "Wait a few minutes for old requests to expire, or paste an operator token instead.",
        ),
        DeviceError::Unknown => ApiError::not_found("No screen is waiting with that code.")
            .with_hint("The request may have expired. Ask the screen to show a new QR code."),
        DeviceError::NotPending => ApiError::new(
            StatusCode::CONFLICT,
            "not_pending",
            "That request was already answered or has expired.",
        )
        .with_hint("Ask the screen to show a new QR code."),
        DeviceError::BadName => ApiError::bad("`name` must be 1 to 60 characters."),
    }
}

fn internal(error: sqlx::Error) -> ApiError {
    tracing::error!("device sign-in: {error}");
    ApiError::server()
}

/// A readable default screen name from a User-Agent, e.g. "Chrome on Linux".
pub fn suggest_name(user_agent: &str) -> String {
    let browser = if user_agent.contains("Edg/") {
        Some("Edge")
    } else if user_agent.contains("OPR/") {
        Some("Opera")
    } else if user_agent.contains("Firefox/") {
        Some("Firefox")
    } else if user_agent.contains("Chrome/") || user_agent.contains("Chromium/") {
        Some("Chrome")
    } else if user_agent.contains("Safari/") {
        Some("Safari")
    } else {
        None
    };
    let system = if user_agent.contains("Android") {
        Some("Android")
    } else if user_agent.contains("iPhone") || user_agent.contains("iPad") {
        Some("iOS")
    } else if user_agent.contains("Windows") {
        Some("Windows")
    } else if user_agent.contains("Mac OS X") {
        Some("macOS")
    } else if user_agent.contains("CrOS") {
        Some("ChromeOS")
    } else if user_agent.contains("Linux") {
        Some("Linux")
    } else {
        None
    };
    match (browser, system) {
        (Some(browser), Some(system)) => format!("{browser} on {system}"),
        (Some(browser), None) => browser.to_string(),
        (None, Some(system)) => format!("New screen ({system})"),
        (None, None) => "New screen".to_string(),
    }
}

/// POST /api/v1/auth/device/start — public.
pub async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let started = state.devices.start(user_agent).map_err(device_error)?;
    Ok(Json(json!({
        "ok": true,
        "code": started.code,
        "pollSecret": started.poll_secret,
        "expiresIn": started.expires_in,
        "publicUrl": state.config.public_url,
    })))
}

/// POST /api/v1/auth/device/poll — public; needs the code and the poll secret.
pub async fn poll(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let code = field(&body, "code");
    let secret = field(&body, "pollSecret");

    match state.devices.poll(code, secret) {
        PollOutcome::Pending => Ok(Json(json!({ "ok": true, "status": "pending" }))),
        PollOutcome::Denied => Ok(Json(json!({ "ok": true, "status": "denied" }))),
        PollOutcome::Expired => Ok(Json(json!({ "ok": true, "status": "expired" }))),
        PollOutcome::Approved {
            delivered: Some(token),
            ..
        } => Ok(Json(
            json!({ "ok": true, "status": "approved", "token": token }),
        )),
        PollOutcome::Approved {
            delivered: None,
            name,
            maker,
        } => {
            let _delivering = DELIVERY.lock().await;
            // Another poll may have delivered while this one waited.
            if let PollOutcome::Approved {
                delivered: Some(token),
                ..
            } = state.devices.poll(code, secret)
            {
                return Ok(Json(
                    json!({ "ok": true, "status": "approved", "token": token }),
                ));
            }

            let token = mint_op_token();
            let (maker_id, maker_name) = maker.unzip();
            // A member removed between approving and this poll no longer
            // vouches for the screen: no token, the screen sees "denied".
            let minted = sqlx::query(
                "INSERT INTO tokens (name, hash, scheme, active, expires, maker_user_id, maker_name)
                 SELECT ?1, ?2, 'sha256', 1, NULL, ?3, ?4
                 WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = ?3)",
            )
            .bind(&name)
            .bind(hash_token(&token))
            .bind(maker_id)
            .bind(maker_name)
            .execute(&state.pool)
            .await
            .map_err(internal)?;
            if minted.rows_affected() == 0 {
                tracing::info!("device sign-in: \"{name}\" was approved by a removed member; denied");
                return Ok(Json(json!({ "ok": true, "status": "denied" })));
            }
            state.devices.record_delivery(code, &token);
            state.events.invalidate();
            tracing::info!("device sign-in: minted a token for screen \"{name}\"");

            Ok(Json(
                json!({ "ok": true, "status": "approved", "token": token }),
            ))
        }
    }
}

/// POST /api/v1/auth/device/lookup — signed-in phone.
pub async fn lookup(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let info = state
        .devices
        .lookup(field(&body, "code"))
        .map_err(device_error)?;
    if info.status != "pending" {
        return Err(device_error(DeviceError::NotPending));
    }
    Ok(Json(json!({
        "ok": true,
        "userAgent": info.user_agent,
        "ageSeconds": info.age_seconds,
        "suggestedName": suggest_name(&info.user_agent),
        "publicUrl": state.config.public_url,
    })))
}

/// POST /api/v1/auth/device/approve — signed-in phone. The screen's token
/// belongs to the approving account, when an account approves.
pub async fn approve(
    State(state): State<AppState>,
    Extension(authed): Extension<Authed>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let maker = crate::accounts::maker(&state.pool, &authed.principal).await?;
    state
        .devices
        .approve(field(&body, "code"), field(&body, "name"), maker)
        .map_err(device_error)?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/v1/auth/device/deny — signed-in phone.
pub async fn deny(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    state
        .devices
        .deny(field(&body, "code"))
        .map_err(device_error)?;
    Ok(Json(json!({ "ok": true })))
}
