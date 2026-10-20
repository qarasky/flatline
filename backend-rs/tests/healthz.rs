//! Liveness and shutdown contracts (A9, A5): `/healthz`, `/api/v1/health`
//! on database failure, and SSE streams ending on the shutdown token.

use std::time::Duration;

use axum::http::StatusCode;
use http_body_util::BodyExt;
use tower::ServiceExt;

mod common;
use common::{get_json, harness, next_sse_data, request, send};

#[tokio::test]
async fn healthz_is_public_and_ok_when_db_and_engine_are_alive() {
    let h = harness().await;
    h.state.engine.start_all().await;

    let (status, json) = send(&h.app, request("GET", "/healthz", None, None)).await;
    assert_eq!(status, StatusCode::OK, "{json}");
    assert_eq!(json["status"], "ok");
    assert_eq!(json["db"]["ok"], true);
    assert_eq!(json["engine"]["ok"], true);
    assert_eq!(json["engine"]["running"], true);
    assert!(json["engine"]["tickAgeMs"].as_u64().is_some());
    h.state.engine.stop_checks().await;
}

#[tokio::test]
async fn healthz_fails_when_the_engine_is_not_running() {
    let h = harness().await;
    // The harness engine is inert until `start_all`.
    let (status, json) = send(&h.app, request("GET", "/healthz", None, None)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json["status"], "unavailable");
    assert_eq!(json["reason"], "engine not running");
    assert_eq!(json["db"]["ok"], true);

    // And again after shutdown stopped it.
    h.state.engine.start_all().await;
    h.state.engine.stop_checks().await;
    let (status, _) = send(&h.app, request("GET", "/healthz", None, None)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn healthz_fails_when_the_database_does() {
    let h = harness().await;
    h.state.engine.start_all().await;
    h.pool.close().await;

    let (status, json) = send(&h.app, request("GET", "/healthz", None, None)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json["reason"], "database error");
    assert_eq!(json["db"]["ok"], false);
    h.state.engine.stop_checks().await;
}

#[tokio::test]
async fn health_reports_a_server_error_instead_of_up_when_the_query_fails() {
    // A9: the fleet query failing used to answer `status: up, total: 0`.
    let h = harness().await;
    sqlx::query("DROP TABLE heartbeats")
        .execute(&h.pool)
        .await
        .unwrap();

    let (status, json) = get_json(&h.app, "/api/v1/health", &h.token).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{json}");
    assert_eq!(json["ok"], false);
    assert!(json.get("health").is_none());
}

#[tokio::test]
async fn sse_streams_end_promptly_on_shutdown() {
    // A5: a stream used to hold the graceful drain open for its 15-minute
    // lifetime, so Docker SIGKILLed the process.
    let h = harness().await;
    let response = h
        .app
        .clone()
        .oneshot(request("GET", "/api/v1/events", Some(&h.token), None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    assert_eq!(next_sse_data(&mut body).await["type"], "ready");

    h.state.engine.shutdown_token().trigger();
    let ended = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(frame) = body.frame().await {
            frame.unwrap();
        }
    })
    .await;
    assert!(ended.is_ok(), "the stream must end on the shutdown token");
}
