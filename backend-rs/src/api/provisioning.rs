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
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::AppState;

/// The provisioning runbook (docs/provisioning.md; embedded so the served doc
/// and the binary always version together).
const RUNBOOK: &str = include_str!("../../../docs/provisioning.md");

/// The installer script template (repository root).
const INSTALLER: &str = include_str!("../../../agent-install.sh");

/// The LLM pointer file, served at `/llms.txt`.
const LLMS: &str = "\
# Flatline

> Flatline is the server-monitoring service for this organisation. This file
> points LLM agents at the tokenized resources for one job: deploy a host
> agent and put its websites on the board.

## Credentials

- `flatline_op_...` — operator token: GUI sign-in and every `/api/v1` call.
- `flatline_agent_push_...` — host (metric) agent token: `/api/push/{token}`
  and `/agent/*` only. It cannot call the operator API.
- `flatline_agent_backup_...` — backup agent token: `/api/backup/v1` only.
- Legacy `flatline_...` tokens still work but must not be minted.

Using a credential on the wrong surface returns an explicit
`agent_token_on_operator_api` / `operator_token_on_agent_api` error with a
`hint`, not a bare 401. Never print a token.

## Start here

- [AI-assisted deployment runbook]({{ORIGIN}}/add-push-server.md?token={{TOKEN}}):
  analyse the host, install or reuse the agent, request operator access,
  add websites and notifications, group and link them, then verify.
- [OpenAPI document]({{ORIGIN}}/api/v1/openapi.json): the full HTTP API.
- [Agent downloads]({{ORIGIN}}/agent/version?token={{TOKEN}}): version, checksums and URLs.
";

/// Prefix for agent build file names served under `/agent/`.
const AGENT_PREFIX: &str = "superboard-";

/// One agent build found in the agent directory.
struct AgentAsset {
    /// Target id derived from the file name, e.g. "linux-amd64".
    platform: String,
    file: String,
    size: u64,
    sha256: String,
}

/// Whether a path segment names an agent build (and nothing else).
fn is_agent_file(name: &str) -> bool {
    let Some(platform) = name.strip_prefix(AGENT_PREFIX) else {
        return false;
    };
    !platform.is_empty()
        && platform
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Identity of a file version: a replaced binary changes size or mtime.
#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

impl FileStamp {
    fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            modified: metadata.modified().ok(),
            len: metadata.len(),
        }
    }
}

/// SHA-256 of each agent binary, keyed by path and invalidated by mtime and
/// size, so `/agent/version` and `/agent/sha256sums` hash a ~10 MB build
/// once per deploy rather than once per request.
static DIGESTS: LazyLock<Mutex<HashMap<PathBuf, (FileStamp, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The SHA-256 hex of a file, from the cache when its stamp is unchanged.
/// Hashing runs on the blocking pool, off the async workers.
async fn file_digest(path: &Path, stamp: &FileStamp) -> Option<String> {
    if let Some((cached_stamp, digest)) = DIGESTS.lock().unwrap().get(path)
        && cached_stamp == stamp
    {
        return Some(digest.clone());
    }

    let owned = path.to_path_buf();
    let digest = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(&owned)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .ok()?
    .ok()?;

    DIGESTS
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), (stamp.clone(), digest.clone()));
    Some(digest)
}

/// Every agent build on disk, named `superboard-<os>-<arch>`.
///
/// The platform is derived from the file name rather than a hardcoded list,
/// so an image (or a developer machine, which builds only its own target)
/// serves whatever it actually ships.
async fn agent_assets(dir: &Path) -> Vec<AgentAsset> {
    let mut out = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return out;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file = entry.file_name().to_string_lossy().to_string();
        if !is_agent_file(&file) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let stamp = FileStamp::of(&metadata);
        let Some(sha256) = file_digest(&path, &stamp).await else {
            continue;
        };
        out.push(AgentAsset {
            platform: file.trim_start_matches(AGENT_PREFIX).to_string(),
            file,
            size: stamp.len,
            sha256,
        });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// Who fetched a provisioning document: an operator or a push agent.
struct Caller {
    token: String,
    kind: CallerKind,
    /// The prefix family actually used, which differs from `kind` for
    /// legacy tokens minted before the split.
    prefix_kind: crate::auth::TokenKind,
    monitor: Option<MonitorIdentity>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CallerKind {
    Operator,
    PushAgent,
}

impl CallerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::PushAgent => "push_agent",
        }
    }
}

struct MonitorIdentity {
    id: i64,
    name: String,
}

impl Caller {
    fn token_kind_prefix(&self) -> &'static str {
        self.prefix_kind.prefix()
    }

    fn monitor_id(&self) -> String {
        self.monitor
            .as_ref()
            .map(|monitor| monitor.id.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn monitor_name(&self) -> String {
        self.monitor
            .as_ref()
            .map(|monitor| monitor.name.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }
}

/// The provisioning credential: `?token=` first, then `Authorization: Bearer`.
///
/// Two credential families are accepted here:
/// - operator tokens (`flatline_op_...`), which can also use the operator API;
/// - push-agent tokens (`flatline_agent_push_...`, or a legacy monitor token),
///   which only unlock the installer, downloads and this runbook.
///
/// Backup-agent tokens are rejected with an explicit message: they are for
/// `/api/backup/v1`, never for the metric-agent installer.
///
/// Called once per request. `Err` carries the response to send: 401 for a
/// missing or invalid token, 503/429 when the token could not be checked.
#[allow(clippy::result_large_err)]
async fn authorize(
    state: &AppState,
    params: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<Caller, Response> {
    let token = params
        .get("token")
        .map(String::as_str)
        .filter(|token| !token.is_empty())
        .or_else(|| crate::auth::bearer(headers))
        .map(str::to_string)
        .ok_or_else(crate::auth::unauthorized)?;

    // Push tokens first: that is what provisioned agents poll with, and the
    // lookup is one indexed query. The monitor identity lets the runbook
    // name the host monitor the AI must link websites to.
    let monitor = sqlx::query_as::<_, (i64, String, i64)>(
        "SELECT id, name, active FROM monitors WHERE push_token = ? LIMIT 1",
    )
    .bind(&token)
    .fetch_optional(&state.pool)
    .await
    .map_err(|error| {
        tracing::error!("provisioning: push token lookup: {error}");
        crate::auth::verify_error_response(&crate::auth::VerifyError::Unavailable(
            error.to_string(),
        ))
    })?;
    if let Some((id, name, _active)) = monitor {
        let prefix_kind = crate::auth::token_kind(&token);
        return Ok(Caller {
            token,
            kind: CallerKind::PushAgent,
            prefix_kind,
            monitor: Some(MonitorIdentity { id, name }),
        });
    }

    match crate::auth::verify_token(&state.pool, &token).await {
        Ok(crate::auth::TokenVerdict::Operator) => {
            let prefix_kind = crate::auth::token_kind(&token);
            Ok(Caller {
                token,
                kind: CallerKind::Operator,
                prefix_kind,
                monitor: None,
            })
        }
        Ok(crate::auth::TokenVerdict::Agent(crate::auth::TokenKind::BackupAgent)) => {
            Err(crate::auth::backup_token_on_metric_agent_api("/agent/*"))
        }
        Ok(crate::auth::TokenVerdict::Agent(_)) => {
            // A push token whose monitor exists but is inactive: say so,
            // because "invalid token" hides the actual fix.
            let inactive: Option<(i64, String)> = sqlx::query_as(
                "SELECT id, name FROM monitors WHERE push_token = ? AND active = 0 LIMIT 1",
            )
            .bind(&token)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
            match inactive {
                Some((id, name)) => Err((
                    axum::http::StatusCode::UNAUTHORIZED,
                    Json(json!({
                        "ok": false,
                        "error": "agent_monitor_inactive",
                        "code": "agent_monitor_inactive",
                        "message": format!("This push-agent token belongs to monitor #{id} ({name}), which is paused."),
                        "tokenKind": "push_agent",
                        "hint": "Resume the monitor (PATCH /api/v1/monitors/{id} {\"active\":true}) with an operator token, then retry. A paused monitor's token cannot download agents or push telemetry.",
                        "docs": "/llms.txt",
                    })),
                )
                    .into_response()),
                None => Err(crate::auth::unauthorized()),
            }
        }
        Ok(crate::auth::TokenVerdict::Invalid) => Err(crate::auth::unauthorized()),
        Err(error) => Err(crate::auth::verify_error_response(&error)),
    }
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
    caller: &Caller,
    version: &str,
) -> String {
    template
        .replace("{{ORIGIN}}", &origin(state, headers))
        .replace("{{TOKEN}}", &caller.token)
        .replace("{{TOKEN_KIND}}", caller.kind.as_str())
        .replace("{{TOKEN_PREFIX}}", caller.token_kind_prefix())
        .replace("{{MONITOR_ID}}", &caller.monitor_id())
        .replace("{{MONITOR_NAME}}", &caller.monitor_name())
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
    let caller = match authorize(&state, &params, &headers).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let version = agent_version(&state)
        .await
        .unwrap_or_else(|| "unknown".to_string());
    let body = render(RUNBOOK, &state, &headers, &caller, &version);
    text_response("text/markdown; charset=utf-8", body)
}

/// GET /llms.txt — the pointer file for LLM crawlers.
pub async fn llms(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let caller = match authorize(&state, &params, &headers).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let body = render(LLMS, &state, &headers, &caller, "unknown");
    text_response("text/plain; charset=utf-8", body)
}

/// GET /agent/install.sh — the installer/updater, pre-credentialed.
pub async fn installer(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let caller = match authorize(&state, &params, &headers).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let version = agent_version(&state)
        .await
        .unwrap_or_else(|| "unknown".to_string());
    let body = render(INSTALLER, &state, &headers, &caller, &version);
    text_response("text/x-shellscript; charset=utf-8", body)
}

/// GET /agent/sha256sums — checksums for the agent binaries on disk.
pub async fn checksums(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state, &params, &headers).await {
        return response;
    }
    let assets = agent_assets(&state.config.agent_dir).await;
    if assets.is_empty() {
        return missing_agent();
    }
    let body = assets
        .iter()
        .map(|asset| format!("{}  {}\n", asset.sha256, asset.file))
        .collect::<String>();
    text_response("text/plain; charset=utf-8", body)
}

/// GET /agent/{file} — one agent build, whatever platform it was built for.
pub async fn agent_file(
    State(state): State<AppState>,
    axum::extract::Path(file): axum::extract::Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state, &params, &headers).await {
        return response;
    }
    if !is_agent_file(&file) {
        return missing_agent();
    }
    agent_binary(&state, &file).await
}

/// Stream one agent build. The caller has already authorized the request.
async fn agent_binary(state: &AppState, file: &str) -> Response {
    let path = state.config.agent_dir.join(file);
    let Ok(handle) = tokio::fs::File::open(&path).await else {
        return missing_agent();
    };
    let Ok(metadata) = handle.metadata().await else {
        return missing_agent();
    };
    if !metadata.is_file() {
        return missing_agent();
    }
    let stamp = FileStamp::of(&metadata);
    let Some(digest) = file_digest(&path, &stamp).await else {
        return missing_agent();
    };

    // Stream in 64 KiB chunks instead of reading the whole build into memory.
    let body = async_stream::stream! {
        use tokio::io::AsyncReadExt;
        let mut handle = handle;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match handle.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => yield Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(&buffer[..read])),
                Err(error) => {
                    yield Err(error);
                    break;
                }
            }
        }
    };

    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file}\""),
            ),
            (header::CONTENT_LENGTH, stamp.len.to_string()),
            (header::ETAG, format!("\"{digest}\"")),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        axum::body::Body::from_stream(body),
    )
        .into_response()
}

/// GET /agent/version — what this deployment ships, with hashes and URLs.
pub async fn version(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state, &params, &headers).await {
        return response;
    }

    let origin = origin(&state, &headers);
    let agents: Vec<_> = agent_assets(&state.config.agent_dir)
        .await
        .into_iter()
        .map(|asset| {
            json!({
                "platform": asset.platform,
                "file": asset.file,
                "size": asset.size,
                "sha256": asset.sha256,
                "url": format!("{origin}/agent/{}", asset.file),
            })
        })
        .collect();

    Json(json!({
        "ok": true,
        "version": agent_version(&state).await,
        "agents": agents,
    }))
    .into_response()
}
