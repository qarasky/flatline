//! Health endpoint contract: token-gated, Node-compatible envelope.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use sqlx::SqlitePool;
use tower::ServiceExt;

use flatline_backend::config::Config;
use flatline_backend::{AppState, api, auth, db};

struct Harness {
    app: axum::Router,
    pool: SqlitePool,
    token: String,
    _dir: tempfile::TempDir,
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        port: 0,
        host: "127.0.0.1".to_string(),
        web_dist: dir.path().join("no-web-build"),
    };
    let pool = db::connect(&config.data_dir).await.unwrap();
    let token = auth::ensure_initial_token(&pool, &config.data_dir)
        .await
        .unwrap()
        .expect("a fresh database mints a token");

    let state = AppState {
        pool: pool.clone(),
        config: std::sync::Arc::new(config),
    };
    Harness {
        app: api::router(state),
        pool,
        token,
        _dir: dir,
    }
}

async fn get_health(app: axum::Router, token: Option<&str>) -> (StatusCode, serde_json::Value) {
    let mut request = Request::builder().uri("/api/v1/health");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn health_requires_a_token() {
    let h = harness().await;
    let (status, json) = get_health(h.app, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"], "unauthorized");
}

#[tokio::test]
async fn health_rejects_a_wrong_token() {
    let h = harness().await;
    let (status, _) = get_health(h.app, Some("flatline_wrong")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn health_reports_an_empty_fleet() {
    let h = harness().await;
    let (status, json) = get_health(h.app, Some(&h.token)).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["ok"], true);
    assert_eq!(json["health"]["total"], 0);
    assert_eq!(json["health"]["status"], "up");
    assert_eq!(json["health"]["downMonitors"], serde_json::json!([]));
}

#[tokio::test]
async fn health_counts_down_and_paused_monitors() {
    let h = harness().await;

    let monitor_id: i64 = sqlx::query_scalar(
        "INSERT INTO monitors (name, type, active) VALUES ('api', 'http', 1) RETURNING id",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO heartbeats (monitor_id, time, status, msg) VALUES (?, '2026-10-12 10:00:00', 0, 'HTTP 503')",
    )
    .bind(monitor_id)
    .execute(&h.pool)
    .await
    .unwrap();

    // A paused monitor is counted separately, never as down.
    sqlx::query("INSERT INTO monitors (name, type, active) VALUES ('paused', 'push', 0)")
        .execute(&h.pool)
        .await
        .unwrap();

    let (status, json) = get_health(h.app, Some(&h.token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["health"]["total"], 2);
    assert_eq!(json["health"]["down"], 1);
    assert_eq!(json["health"]["paused"], 1);
    assert_eq!(json["health"]["status"], "down");
    assert_eq!(json["health"]["downMonitors"][0]["name"], "api");
}
