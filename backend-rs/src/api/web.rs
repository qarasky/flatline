//! SPA serving: the built dashboard from `FLATLINE_WEB_DIST`.
//!
//! Routing contract (mirrors `server/static-app.js`):
//! - `/assets/*` are content-hashed: immutable, cached for a year.
//! - Other files in the build are served as-is, no caching.
//! - Every other GET/HEAD that is not an API path returns the SPA shell, so
//!   client-side routes survive a reload.
//! - API paths (`/api`, `/upload`, `/metrics`, `/.well-known`) are never
//!   answered by the SPA; their JSON 404s stay JSON.
//!
//! Filesystem checks are async, and file bytes are cached in memory
//! (bounded, invalidated by size and mtime), so a reload storm does not
//! re-read the build or block runtime workers (A12).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use axum::body::Bytes;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;

/// Paths the SPA must never answer for. Prefixes are matched on path
/// boundaries so `/apifoo` is not treated as an API path.
pub fn is_api_path(path: &str) -> bool {
    path == "/api"
        || path.starts_with("/api/")
        || path == "/upload"
        || path.starts_with("/upload/")
        || path == "/metrics"
        || path.starts_with("/.well-known/")
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({
            "ok": false,
            "error": "not_found",
            "message": "No such endpoint.",
        })),
    )
        .into_response()
}

/// The final fallback of the app router.
pub async fn fallback(State(state): State<AppState>, request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return not_found();
    }

    let path = request.uri().path().to_string();
    if is_api_path(&path) {
        return not_found();
    }

    let dist = state.config.web_dist.clone();
    let index = dist.join("index.html");
    // Async metadata: a sync `exists`/`canonicalize` blocked a runtime
    // worker on every SPA request.
    if !tokio::fs::metadata(&index)
        .await
        .map(|meta| meta.is_file())
        .unwrap_or(false)
    {
        // No build: keep the pure API behaviour.
        return not_found();
    }

    let is_head = request.method() == Method::HEAD;
    let relative = path.trim_start_matches('/');
    let candidate = dist.join(relative);

    if let Some(file) = resolve(&dist, &candidate).await {
        return file_response(&file, &path, is_head).await;
    }

    // A miss under /assets is a real 404 (content-hashed names never change);
    // anything else gets the SPA shell for client-side routing.
    if path.starts_with("/assets/") {
        return not_found();
    }
    file_response(&index, &path, is_head).await
}

/// Canonicalise and confine the candidate to the build directory, so a
/// crafted path cannot escape it.
async fn resolve(dist: &Path, candidate: &Path) -> Option<PathBuf> {
    let dist = tokio::fs::canonicalize(dist).await.ok()?;
    let resolved = tokio::fs::canonicalize(candidate).await.ok()?;
    let is_file = tokio::fs::metadata(&resolved).await.ok()?.is_file();
    if resolved.starts_with(&dist) && is_file {
        Some(resolved)
    } else {
        None
    }
}

/// Files at most this large are kept in memory once read.
const CACHE_FILE_MAX: u64 = 2 * 1024 * 1024;
/// Total bytes the file cache may hold.
const CACHE_TOTAL_MAX: u64 = 64 * 1024 * 1024;

/// Bytes of a file version, identified by size and mtime.
struct CachedFile {
    modified: Option<SystemTime>,
    len: u64,
    bytes: Bytes,
}

/// Build files served from memory: the shell and hashed assets are read
/// once per deploy instead of on every request. A rebuilt file changes
/// size or mtime and is re-read.
static FILES: LazyLock<Mutex<HashMap<PathBuf, CachedFile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn read_cached(file: &Path) -> Option<Bytes> {
    let meta = tokio::fs::metadata(file).await.ok()?;
    let modified = meta.modified().ok();
    let len = meta.len();
    if let Some(hit) = FILES.lock().unwrap().get(file)
        && hit.len == len
        && hit.modified == modified
    {
        return Some(hit.bytes.clone());
    }

    let bytes = Bytes::from(tokio::fs::read(file).await.ok()?);
    if len <= CACHE_FILE_MAX {
        let mut files = FILES.lock().unwrap();
        let held: u64 = files.values().map(|cached| cached.len).sum();
        if held + len > CACHE_TOTAL_MAX {
            files.clear();
        }
        files.insert(
            file.to_path_buf(),
            CachedFile {
                modified,
                len,
                bytes: bytes.clone(),
            },
        );
    }
    Some(bytes)
}

async fn file_response(file: &Path, request_path: &str, is_head: bool) -> Response {
    let Some(bytes) = read_cached(file).await else {
        return not_found();
    };
    let content_type = content_type(file);
    let cache = if request_path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=0"
    };

    let length = bytes.len();
    let body = if is_head {
        axum::body::Body::empty()
    } else {
        axum::body::Body::from(bytes)
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .header(header::CONTENT_LENGTH, length)
        .body(body)
        .unwrap_or_else(|_| not_found())
}

fn content_type(file: &Path) -> &'static str {
    match file.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("webmanifest") => "application/manifest+json",
        Some("json") | Some("map") => "application/json",
        Some("txt") => "text/plain; charset=utf-8",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths_are_recognised_on_boundaries() {
        assert!(is_api_path("/api"));
        assert!(is_api_path("/api/v1/health"));
        assert!(is_api_path("/upload/a.png"));
        assert!(is_api_path("/metrics"));
        assert!(is_api_path("/.well-known/x"));
        assert!(!is_api_path("/apifoo"));
        assert!(!is_api_path("/dashboard"));
        assert!(!is_api_path("/"));
    }
}
