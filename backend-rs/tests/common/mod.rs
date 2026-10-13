//! Shared integration-test harness: a real router over a real SQLite file.
#![allow(dead_code)]

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::SqlitePool;
use tower::ServiceExt;

use flatline_backend::config::Config;
use flatline_backend::{AppState, api, auth, db, events::Events};

pub struct Harness {
    pub app: Router,
    pub pool: SqlitePool,
    pub token: String,
    pub state: AppState,
    pub _dir: tempfile::TempDir,
}

/// A fresh instance with a minted token, no monitors.
pub async fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        port: 0,
        host: "127.0.0.1".to_string(),
        web_dist: dir.path().join("no-web-build"),
        public_url: None,
        agent_dir: dir.path().join("agent"),
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
    let state = AppState {
        pool: pool.clone(),
        config: std::sync::Arc::new(config),
        events,
        engine,
        metrics,
        status_page_secret: std::sync::Arc::new(status_page_secret),
    };

    Harness {
        app: api::router(state.clone()),
        pool,
        token,
        state,
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
