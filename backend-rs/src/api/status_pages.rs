//! Status-page read API: host resolution, page data, heartbeats, incident
//! history, the PWA manifest, the page badge and the password gate.

use std::collections::HashMap;
use std::sync::LazyLock;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::api::public_cache::{self, PUBLIC_TTL, ResponseCache};
use crate::badges::{self, Badge};
use crate::status_pages::{self, Page, UNLOCK_TTL_SECONDS};

/// GET /api/status-page/resolve-host
pub async fn resolve_host(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Json<Value> {
    let mut host = params
        .get("host")
        .map(|host| host.trim().to_lowercase())
        .unwrap_or_default();
    if host.is_empty() {
        host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_lowercase();
    }
    // Drop any port so "example.com:3001" matches "example.com".
    let host = host.split(':').next().unwrap_or("").to_string();

    let slug = status_pages::resolve_host(&state.pool, &host).await;

    Json(json!({
        "ok": true,
        "host": host,
        "slug": slug,
        "matched": slug.is_some(),
    }))
}

/// Cached page payloads (`page`, `heartbeat`, `incident-history`).
static PAGE_CACHE: LazyLock<ResponseCache<Value>> =
    LazyLock::new(|| ResponseCache::new(PUBLIC_TTL, 1024));
/// Cached aggregate badge flags: (has_up, has_down, has_maintenance).
static BADGE_CACHE: LazyLock<ResponseCache<(bool, bool, bool)>> =
    LazyLock::new(|| ResponseCache::new(PUBLIC_TTL, 1024));

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Status Page Not Found").into_response()
}

/// Gate a status-page data endpoint, mirroring `requireUnlocked`.
///
/// An unpublished page is a 404 to the public — exactly like a missing
/// slug, so its existence is not confirmed (A14). A request carrying a
/// valid operator bearer token still sees it, which keeps previews and API
/// tooling working; the dashboard's own status-page view sends no token
/// and so sees only published pages.
///
/// The page row itself is never cached, so publishing, unpublishing or
/// locking a page applies to the very next request.
///
/// The Err variant carries a ready-to-send response, which is fine here —
/// this runs once per gated request, never in a hot loop.
#[allow(clippy::result_large_err)]
async fn require_unlocked(
    state: &AppState,
    headers: &HeaderMap,
    slug: &str,
) -> Result<Page, Response> {
    let page = match status_pages::load(&state.pool, slug).await {
        Ok(Some(page)) => page,
        Ok(None) => return Err(not_found()),
        Err(error) => return Err(server_error(error)),
    };

    if page.published == 0 {
        match crate::auth::bearer(headers) {
            None => return Err(not_found()),
            Some(token) => match crate::auth::verify_token(&state.pool, token).await {
                Ok(true) => {}
                Ok(false) => return Err(not_found()),
                Err(error) => return Err(crate::auth::verify_error_response(&error)),
            },
        }
    }

    if status_pages::is_unlocked(&state.status_page_secret, headers, &page) {
        Ok(page)
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Form")],
            Json(json!({
                "ok": false,
                "error": "password_required",
                "message": "This status page is password protected.",
            })),
        )
            .into_response())
    }
}

fn server_error(error: sqlx::Error) -> Response {
    tracing::error!("status pages api: {error}");
    ApiError::server().into_response()
}

/// GET /api/status-page/{slug}
pub async fn page(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Response {
    let page = match require_unlocked(&state, &headers, &slug).await {
        Ok(page) => page,
        Err(response) => return response,
    };
    let key = public_cache::key(&state, &format!("page|{}", page.id));
    match PAGE_CACHE
        .get_or_try(key, || status_pages::page_data(&state.pool, &page))
        .await
    {
        Ok(data) => Json(data).into_response(),
        Err(error) => server_error(error),
    }
}

/// GET /api/status-page/heartbeat/{slug}
pub async fn heartbeat(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Response {
    let page = match require_unlocked(&state, &headers, &slug).await {
        Ok(page) => page,
        Err(response) => return response,
    };
    let key = public_cache::key(&state, &format!("heartbeat|{}", page.id));
    match PAGE_CACHE
        .get_or_try(key, || {
            status_pages::heartbeat_data(&state.pool, &state.engine, &page)
        })
        .await
    {
        Ok(data) => Json(data).into_response(),
        Err(error) => server_error(error),
    }
}

/// GET /api/status-page/{slug}/incident-history
pub async fn incident_history(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let page = match require_unlocked(&state, &headers, &slug).await {
        Ok(page) => page,
        Err(response) => return response,
    };
    let cursor = params.get("cursor").map(String::as_str);
    let key = public_cache::key(
        &state,
        &format!("incidents|{}|{}", page.id, cursor.unwrap_or("")),
    );
    match PAGE_CACHE
        .get_or_try(key, || {
            status_pages::incident_history(&state.pool, page.id, cursor)
        })
        .await
    {
        Ok(data) => Json(data).into_response(),
        Err(error) => server_error(error),
    }
}

/// GET /api/status-page/{slug}/manifest.json
pub async fn manifest(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Response {
    match require_unlocked(&state, &headers, &slug).await {
        Ok(page) => Json(json!({
            "name": page.title,
            "start_url": format!("/status/{}", page.slug),
            "display": "standalone",
            "icons": [{
                "src": page.icon.clone().filter(|icon| !icon.is_empty()).unwrap_or_else(|| "/icon.svg".to_string()),
                "sizes": "128x128",
                "type": "image/png",
            }],
        }))
        .into_response(),
        Err(response) => response,
    }
}

/// Aggregate (has_up, has_down, has_maintenance) over the page's public
/// monitors, from one batched latest-beat statement.
async fn badge_flags(state: &AppState, page_id: i64) -> sqlx::Result<(bool, bool, bool)> {
    let ids = status_pages::public_monitor_ids(&state.pool, page_id).await?;
    let latest = status_pages::recent_beats(&state.pool, &ids, 1).await?;

    let mut has_up = false;
    let mut has_down = false;
    let mut has_maintenance = false;
    for monitor_id in ids {
        let status = latest
            .get(&monitor_id)
            .and_then(|beats| beats.first())
            .map(|beat| beat.status);
        match status {
            Some(3) => has_maintenance = true,
            Some(2) | None => {}
            Some(1) => has_up = true,
            _ => has_down = true,
        }
    }
    Ok((has_up, has_down, has_maintenance))
}

/// GET /api/status-page/{slug}/badge — aggregate status across the page's
/// public monitors.
pub async fn badge(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let page = match require_unlocked(&state, &headers, &slug).await {
        Ok(page) => page,
        Err(response) => return response,
    };

    let key = public_cache::key(&state, &format!("badge|{}", page.id));
    let (has_up, has_down, has_maintenance) = match BADGE_CACHE
        .get_or_try(key, || badge_flags(&state, page.id))
        .await
    {
        Ok(flags) => flags,
        Err(error) => return server_error(error),
    };

    let label = badges::query_string(&params, "label");
    let style = badges::query_or(&params, "style", "flat");
    let (message, color) = if !has_up && !has_down && !has_maintenance {
        ("N/A", "#999".to_string())
    } else if has_maintenance {
        (
            "Maintenance",
            badges::query_or(&params, "maintenanceColor", "#808080").to_string(),
        )
    } else if has_up && !has_down {
        (
            "Up",
            badges::query_or(&params, "upColor", "#66c20a").to_string(),
        )
    } else if has_up && has_down {
        (
            "Degraded",
            badges::query_or(&params, "partialColor", "#F6BE00").to_string(),
        )
    } else {
        (
            "Down",
            badges::query_or(&params, "downColor", "#c2290a").to_string(),
        )
    };

    let svg = badges::render(&Badge {
        label,
        message,
        color: &color,
        label_color: "",
        style,
    });
    ([(header::CONTENT_TYPE, "image/svg+xml")], svg).into_response()
}

/// POST /api/v1/status-pages/unlock/{slug}
pub async fn unlock(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let slug = slug.to_lowercase();
    let page = status_pages::load(&state.pool, &slug).await.ok().flatten();

    // Do not confirm whether a slug exists — or an unpublished page.
    let Some(page) = page.filter(|page| page.published != 0) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    let Some(hash) = page
        .password
        .as_deref()
        .filter(|password| !password.is_empty())
    else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };

    let password = extract_password(&body, &headers);
    // bcrypt is tens of milliseconds of CPU: keep it off the async workers.
    let hash = hash.to_string();
    let matches =
        tokio::task::spawn_blocking(move || bcrypt::verify(&password, &hash).unwrap_or(false))
            .await
            .unwrap_or(false);
    if !matches {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            status_pages::render_password_prompt(&slug, Some("That password is not correct.")),
        )
            .into_response();
    }

    tracing::info!("auth: unlocked status page \"{slug}\"");

    let expires_at = Utc::now().timestamp() + UNLOCK_TTL_SECONDS;
    let value = status_pages::sign_unlock(&state.status_page_secret, &slug, expires_at);
    let cookie = format!(
        "{}={value}; Max-Age={UNLOCK_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax",
        status_pages::AUTH_COOKIE
    );
    let back = headers
        .get(header::REFERER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let back = if back.is_empty() {
        format!("/status/{slug}")
    } else {
        back
    };

    (
        StatusCode::FOUND,
        [(header::SET_COOKIE, cookie), (header::LOCATION, back)],
    )
        .into_response()
}

/// The password from a JSON or urlencoded body.
fn extract_password(body: &Bytes, headers: &HeaderMap) -> String {
    if body.is_empty() {
        return String::new();
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if content_type.contains("json")
        && let Ok(value) = serde_json::from_slice::<Value>(body)
        && let Some(password) = value.get("password").and_then(Value::as_str)
    {
        return password.to_string();
    }

    // urlencoded fallback: password=...
    let text = String::from_utf8_lossy(body);
    for pair in text.split('&') {
        if let Some((key, value)) = pair.split_once('=')
            && key == "password"
        {
            return percent_decode(value);
        }
    }
    String::new()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// GET /robots.txt — advisory only, like the Node route.
pub async fn robots() -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain")],
        "User-agent: *\nDisallow: /\n",
    )
        .into_response()
}
