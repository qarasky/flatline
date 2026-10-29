//! Shared integration-test harness: a real router over a real SQLite file.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::SqlitePool;
use tower::ServiceExt;

use flatline_backend::backups::storage::{
    FaultInjector, FreeSpace, NoFaults, STORAGE_MARKER, SystemFreeSpace,
};
use flatline_backend::config::Config;
use flatline_backend::{AppState, api, auth, db, events::Events};

pub struct Harness {
    pub app: Router,
    pub pool: SqlitePool,
    pub token: String,
    pub state: AppState,
    /// Provisioned backup root, when this harness enabled backup storage.
    pub backup_root: Option<PathBuf>,
    pub _dir: tempfile::TempDir,
}

/// A fresh instance with a minted token, no monitors, storage disabled.
pub async fn harness() -> Harness {
    harness_inner(None).await
}

/// A harness whose backup storage root is provisioned. Tests pass deterministic
/// free space and crash points; the router and service share them.
pub async fn harness_with_backups(
    free: Arc<dyn FreeSpace>,
    faults: Arc<dyn FaultInjector>,
) -> Harness {
    harness_inner(Some((free, faults))).await
}

async fn harness_inner(storage: Option<(Arc<dyn FreeSpace>, Arc<dyn FaultInjector>)>) -> Harness {
    // The cheapest bcrypt cost: tests hash many passwords.
    flatline_backend::accounts::set_password_cost(4);
    let dir = tempfile::tempdir().unwrap();
    let (backup_dir, backup_root, free, faults) = match storage {
        Some((free, faults)) => {
            let root = dir.path().join("backups");
            std::fs::create_dir(&root).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            std::fs::write(root.join(STORAGE_MARKER), uuid::Uuid::new_v4().to_string()).unwrap();
            (Some(root.clone()), Some(root), free, faults)
        }
        None => (
            None,
            None,
            Arc::new(SystemFreeSpace) as Arc<dyn FreeSpace>,
            Arc::new(NoFaults) as Arc<dyn FaultInjector>,
        ),
    };
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        port: 0,
        host: "127.0.0.1".to_string(),
        web_dist: dir.path().join("no-web-build"),
        public_url: None,
        agent_dir: dir.path().join("agent"),
        backup_agent_dir: dir.path().join("backup-agent"),
        backup_dir,
        heartbeat_retention_days: 0,
    };
    let pool = db::connect(&config.data_dir).await.unwrap();
    let token = auth::ensure_initial_token(&pool, &config.data_dir)
        .await
        .unwrap()
        .expect("a fresh database mints a token");

    let events = Events::new();
    // The test seam skips the push watcher's boot delay; engine tests call
    // `start_all` explicitly, everything else stays inert.
    let engine = flatline_backend::monitors::engine::Engine::for_tests(
        pool.clone(),
        std::sync::Arc::clone(&events),
    );
    let metrics =
        flatline_backend::metrics::Metrics::new(pool.clone(), std::sync::Arc::clone(&events));
    let status_page_secret =
        flatline_backend::status_pages::ensure_secret(&config.data_dir).unwrap();
    let config = std::sync::Arc::new(config);
    let backups = flatline_backend::backups::Backups::with_io(
        pool.clone(),
        std::sync::Arc::clone(&config),
        std::sync::Arc::clone(&events),
        free,
        faults,
    );
    let state = AppState {
        pool: pool.clone(),
        config,
        events,
        engine,
        metrics,
        backups,
        status_page_secret: std::sync::Arc::new(status_page_secret),
        strips: std::sync::Arc::new(flatline_backend::api::strips::StripCache::new()),
        devices: std::sync::Arc::new(flatline_backend::device::DeviceRequests::new()),
    };

    Harness {
        app: api::router(state.clone()),
        pool,
        token,
        state,
        backup_root,
        _dir: dir,
    }
}

/// Build a request with an optional bearer token and JSON body.
pub fn request(method: &str, uri: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

/// Send a request and decode the JSON envelope.
pub async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, json)
}

/// Convenience: token-authenticated GET returning decoded JSON.
pub async fn get_json(app: &Router, uri: &str, token: &str) -> (StatusCode, Value) {
    send(app, request("GET", uri, Some(token), None)).await
}

/// Read the next SSE `data:` frame from a streaming body, skipping
/// keepalive comments.
pub async fn next_sse_data(body: &mut axum::body::Body) -> Value {
    let mut buffer = String::new();
    loop {
        let Some(frame) = body.frame().await else {
            panic!("stream ended before a data frame arrived");
        };
        let frame = frame.unwrap();
        let Ok(data) = frame.into_data() else {
            continue;
        };
        buffer.push_str(&String::from_utf8_lossy(&data));

        while let Some(boundary) = buffer.find("\n\n") {
            let raw = buffer[..boundary].to_string();
            buffer = buffer[boundary + 2..].to_string();
            let payload: String = raw
                .lines()
                .filter(|line| line.starts_with("data:"))
                .map(|line| line.trim_start_matches("data:").trim_start())
                .collect::<Vec<_>>()
                .join("\n");
            if payload.is_empty() {
                continue;
            }
            return serde_json::from_str(&payload).expect("SSE data must be JSON");
        }
    }
}

/// Send a request and return status, Set-Cookie (if any) and the JSON body.
pub async fn send_full(app: &Router, request: Request<Body>) -> (StatusCode, Option<String>, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().to_string());
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, cookie, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// The `fl_session` value from a Set-Cookie header.
pub fn cookie_value(set_cookie: &str) -> String {
    set_cookie
        .strip_prefix("fl_session=")
        .and_then(|rest| rest.split(';').next())
        .expect("an fl_session cookie")
        .to_string()
}

/// A request authenticated only by the session cookie. Writes carry the
/// CSRF header; use [`with_bare_cookie`] to leave it off.
pub fn with_cookie(method: &str, uri: &str, session: &str, body: Option<Value>) -> Request<Body> {
    let mut req = with_bare_cookie(method, uri, session, body);
    if method != "GET" {
        req.headers_mut()
            .insert("x-flatline-csrf", "1".parse().unwrap());
    }
    req
}

/// A cookie-authenticated request without the CSRF header.
pub fn with_bare_cookie(method: &str, uri: &str, session: &str, body: Option<Value>) -> Request<Body> {
    let mut req = request(method, uri, None, body);
    req.headers_mut()
        .insert("cookie", format!("fl_session={session}").parse().unwrap());
    req
}

/// Sign in with a body (`{token}` or `{email, password}`) and return the
/// session id the cookie carries.
pub async fn sign_in(app: &Router, body: Value) -> String {
    let (status, cookie, body) =
        send_full(app, request("POST", "/api/v1/auth/session", None, Some(body))).await;
    assert_eq!(status, StatusCode::OK, "sign-in failed: {body}");
    cookie_value(&cookie.expect("a session cookie"))
}

/// Add a member with the bearer token; returns their id.
pub async fn add_member(h: &Harness, email: &str, name: &str, password: &str) -> i64 {
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/users",
            Some(&h.token),
            Some(serde_json::json!({ "email": email, "name": name, "password": password })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["user"]["id"].as_i64().unwrap()
}
