//! Provisioning surfaces: the LLM-facing runbook, the agent installer and
//! the agent binaries.
//!
//! Everything here is gated by the same operator token as the API, taken
//! from `?token=` or `Authorization: Bearer`. The query form exists because
//! LLM fetch tools and shell one-liners cannot always set headers; the
//! token is a real (revocable) API key from the dashboard's Agents panel.
//!
//! The runbook and the installer are embedded in the binary and rendered
//! per request with the origin, token and agent version substituted, so
//! every command in the served document is copy-paste ready.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::AppState;

/// The provisioning runbook (repository root; embedded so the served doc
/// and the binary always version together).
const RUNBOOK: &str = include_str!("../../../add-push-server.md");

/// The installer script template (repository root).
const INSTALLER: &str = include_str!("../../../agent-install.sh");

/// The LLM pointer file, served at `/llms.txt`.
const LLMS: &str = "\
# Flatline

> Flatline is the server-monitoring service for this organisation. This file
> points LLM agents at the provisioning runbook, which is tokenized and
> ready to use as-is.

- [Provisioning runbook]({{ORIGIN}}/add-push-server.md?token={{TOKEN}}): add servers, monitors and groups; install or update the monitoring agent.
- [OpenAPI document]({{ORIGIN}}/api/v1/openapi.json): the full HTTP API.
- [Agent downloads]({{ORIGIN}}/agent/version?token={{TOKEN}}): latest agent version, checksums and URLs.
";

/// Agent binaries built into the image, in checksums-file order.
const AGENT_FILES: &[(&str, &str)] = &[
    ("linux-amd64", "superboard-linux-amd64"),
    ("linux-arm64", "superboard-linux-arm64"),
];

/// The provisioning token: `?token=` first, then `Authorization: Bearer`.
/// Validated against the tokens table, so it is any active API key.
async fn authorize(
    state: &AppState,
    params: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Option<String> {
    let token = params
        .get("token")
        .map(String::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        })?;

    crate::auth::verify_token(&state.pool, &token)
        .await
        .then_some(token)
}

/// Public origin for rendered links: the configured `FLATLINE_PUBLIC_URL`
/// when set, else the request's host and forwarded scheme (a container
/// behind a proxy must set the env for correct absolute URLs).
fn origin(state: &AppState, headers: &HeaderMap) -> String {
    if let Some(url) = state
        .config
        .public_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        return url.trim_end_matches('/').to_string();
    }

    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|value| value.to_str().ok())
        .filter(|host| !host.is_empty())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|scheme| *scheme == "http" || *scheme == "https")
        .unwrap_or("https");
    format!("{scheme}://{host}")
}

/// Version reported by the `VERSION` file next to the agent binaries.
async fn agent_version(state: &AppState) -> Option<String> {
    let raw = tokio::fs::read_to_string(state.config.agent_dir.join("VERSION"))
        .await
        .ok()?;
    let version = raw.trim().to_string();
    (!version.is_empty()).then_some(version)
}

fn render(
    template: &str,
    state: &AppState,
    headers: &HeaderMap,
    token: &str,
    version: &str,
) -> String {
    template
        .replace("{{ORIGIN}}", &origin(state, headers))
        .replace("{{TOKEN}}", token)
        .replace("{{AGENT_VERSION}}", version)
}

/// Text response with no-store: these bodies embed a credential.
fn text_response(content_type: &'static str, body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

fn missing_agent() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(json!({
            "ok": false,
            "error": "not_found",
            "message": "No agent build is available in this image.",
        })),
    )
        .into_response()
}

/// GET /add-push-server.md — the LLM provisioning runbook.
pub async fn runbook(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = authorize(&state, &params, &headers).await else {
        return crate::auth::unauthorized();
    };
    let version = agent_version(&state)
        .await
        .unwrap_or_else(|| "unknown".to_string());
    let body = render(RUNBOOK, &state, &headers, &token, &version);
    text_response("text/markdown; charset=utf-8", body)
}

/// GET /llms.txt — the pointer file for LLM crawlers.
pub async fn llms(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = authorize(&state, &params, &headers).await else {
        return crate::auth::unauthorized();
    };
    let body = render(LLMS, &state, &headers, &token, "unknown");
    text_response("text/plain; charset=utf-8", body)
}

/// GET /agent/install.sh — the installer/updater, pre-credentialed.
pub async fn installer(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = authorize(&state, &params, &headers).await else {
        return crate::auth::unauthorized();
    };
    let body = render(INSTALLER, &state, &headers, &token, "unknown");
    text_response("text/x-shellscript; charset=utf-8", body)
}

/// GET /agent/sha256sums — checksums for the binaries in this image.
pub async fn checksums(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if authorize(&state, &params, &headers).await.is_none() {
        return crate::auth::unauthorized();
    }
    match tokio::fs::read_to_string(state.config.agent_dir.join("sha256sums")).await {
        Ok(body) => text_response("text/plain; charset=utf-8", body),
        Err(_) => missing_agent(),
    }
}

/// GET /agent/superboard-linux-amd64
pub async fn agent_amd64(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    agent_binary(&state, &params, &headers, "superboard-linux-amd64").await
}

/// GET /agent/superboard-linux-arm64
pub async fn agent_arm64(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    agent_binary(&state, &params, &headers, "superboard-linux-arm64").await
}

async fn agent_binary(
    state: &AppState,
    params: &HashMap<String, String>,
    headers: &HeaderMap,
    file: &'static str,
) -> Response {
    if authorize(state, params, headers).await.is_none() {
        return crate::auth::unauthorized();
    }

    let bytes = match tokio::fs::read(state.config.agent_dir.join(file)).await {
        Ok(bytes) => bytes,
        Err(_) => return missing_agent(),
    };

    let digest = hex::encode(Sha256::digest(&bytes));
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file}\""),
            ),
            (header::ETAG, format!("\"{digest}\"")),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        bytes,
    )
        .into_response()
}

/// GET /agent/version — what this image ships, with hashes and URLs.
pub async fn version(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if authorize(&state, &params, &headers).await.is_none() {
        return crate::auth::unauthorized();
    }

    let origin = origin(&state, &headers);
    let mut agents = Vec::new();
    for (platform, file) in AGENT_FILES {
        let Ok(bytes) = tokio::fs::read(state.config.agent_dir.join(file)).await else {
            continue;
        };
        agents.push(json!({
            "platform": platform,
            "file": file,
            "size": bytes.len(),
            "sha256": hex::encode(Sha256::digest(&bytes)),
            "url": format!("{origin}/agent/{file}"),
        }));
    }

    Json(json!({
        "ok": true,
        "version": agent_version(&state).await,
        "agents": agents,
    }))
    .into_response()
}
