//! Token checks over HTTP: a token-store failure is 503, never 401 (A1).

use axum::http::StatusCode;
use serde_json::json;

mod common;
use common::{harness, request, send};

#[tokio::test]
async fn a_failing_token_store_answers_503_not_401() {
    let h = harness().await;

    // Sanity: the token works while the database does.
    let (status, _) = send(
        &h.app,
        request("GET", "/api/v1/auth/me", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    h.pool.close().await;

    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "unavailable");

    // The SSE endpoint goes through the same middleware.
    let (status, _) = send(
        &h.app,
        request("GET", "/api/v1/events", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // Sign-in must not tell the operator their token is wrong either.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "username": "", "password": h.token })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "unavailable");

    // Provisioning shares the rule.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/agent/version?token={}", h.token),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // A missing token is still a plain 401: nothing to check.
    let (status, _) = send(&h.app, request("GET", "/api/v1/monitors", None, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_tokens_are_still_401() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some("flatline_nope"), None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}
