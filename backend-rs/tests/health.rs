//! Health endpoint contract: token-gated, Node-compatible envelope.

use axum::http::StatusCode;

mod common;
use common::{get_json, harness, request, send};

#[tokio::test]
async fn health_requires_a_token() {
    let h = harness().await;
    let (status, json) = send(&h.app, request("GET", "/api/v1/health", None, None)).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"], "unauthorized");
}

#[tokio::test]
async fn health_rejects_a_wrong_token() {
    let h = harness().await;
    let (status, _) = get_json(&h.app, "/api/v1/health", "flatline_wrong").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn health_reports_an_empty_fleet() {
    let h = harness().await;
    let (status, json) = get_json(&h.app, "/api/v1/health", &h.token).await;

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

    let (status, json) = get_json(&h.app, "/api/v1/health", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["health"]["total"], 2);
    assert_eq!(json["health"]["down"], 1);
    assert_eq!(json["health"]["paused"], 1);
    assert_eq!(json["health"]["status"], "down");
    assert_eq!(json["health"]["downMonitors"][0]["name"], "api");
}
