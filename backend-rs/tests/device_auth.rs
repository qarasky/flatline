//! Sign in with a QR code: a screen starts a request, a signed-in phone
//! approves it, the screen collects its own operator token.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{Harness, harness, request, send};

const START: &str = "/api/v1/auth/device/start";
const POLL: &str = "/api/v1/auth/device/poll";
const LOOKUP: &str = "/api/v1/auth/device/lookup";
const APPROVE: &str = "/api/v1/auth/device/approve";
const DENY: &str = "/api/v1/auth/device/deny";

async fn post(h: &Harness, uri: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    send(&h.app, request("POST", uri, token, Some(body))).await
}

/// Start a request; returns (code, pollSecret).
async fn start(h: &Harness) -> (String, String) {
    let (status, body) = post(h, START, None, json!({})).await;
    assert_eq!(status, StatusCode::OK, "start failed: {body}");
    (
        body["code"].as_str().unwrap().to_string(),
        body["pollSecret"].as_str().unwrap().to_string(),
    )
}

async fn poll(h: &Harness, code: &str, secret: &str) -> Value {
    let (status, body) = post(h, POLL, None, json!({ "code": code, "pollSecret": secret })).await;
    assert_eq!(status, StatusCode::OK, "poll failed: {body}");
    body
}

async fn approve(h: &Harness, code: &str, name: &str) -> (StatusCode, Value) {
    post(
        h,
        APPROVE,
        Some(&h.token),
        json!({ "code": code, "name": name }),
    )
    .await
}

async fn token_rows(h: &Harness) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM tokens")
        .fetch_one(&h.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn start_poll_approve_poll_delivers_a_working_token() {
    let h = harness().await;
    let (code, secret) = start(&h).await;

    assert_eq!(poll(&h, &code, &secret).await["status"], "pending");

    let (status, _) = approve(&h, &code, "Living room TV").await;
    assert_eq!(status, StatusCode::OK);

    let body = poll(&h, &code, &secret).await;
    assert_eq!(body["status"], "approved");
    let token = body["token"].as_str().unwrap();
    assert!(token.starts_with("flatline_op_"));

    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(token), None)).await;
    assert_eq!(status, StatusCode::OK, "the delivered token must sign in");
}

#[tokio::test]
async fn poll_with_only_the_code_never_returns_the_token() {
    let h = harness().await;
    let (code, secret) = start(&h).await;
    approve(&h, &code, "TV").await;

    // Someone who photographed the QR code knows the code, not the secret.
    for guess in [code.as_str(), "", "not-the-secret"] {
        let body = poll(&h, &code, guess).await;
        assert_eq!(body["status"], "expired");
        assert!(body.get("token").is_none());
    }
    assert_eq!(token_rows(&h).await, 1, "no token may be minted for them");

    // The real screen still gets its token afterwards.
    assert_eq!(poll(&h, &code, &secret).await["status"], "approved");
}

#[tokio::test]
async fn lost_delivery_retry_returns_same_token_and_one_row() {
    let h = harness().await;
    let (code, secret) = start(&h).await;
    approve(&h, &code, "TV").await;
    let before = token_rows(&h).await;

    let first = poll(&h, &code, &secret).await;
    let second = poll(&h, &code, &secret).await;

    assert_eq!(first["token"], second["token"]);
    assert_eq!(token_rows(&h).await, before + 1);
}

#[tokio::test]
async fn retry_window_closed_returns_expired_and_no_new_row() {
    let base = Instant::now();
    let offset = Arc::new(Mutex::new(Duration::ZERO));
    let clock = Arc::clone(&offset);
    let mut h = harness().await;
    h.state.devices = Arc::new(flatline_backend::device::DeviceRequests::new_with_clock(
        Arc::new(move || base + *clock.lock().unwrap()),
    ));
    h.app = flatline_backend::api::router(h.state.clone());

    let (code, secret) = start(&h).await;
    approve(&h, &code, "TV").await;
    assert_eq!(poll(&h, &code, &secret).await["status"], "approved");
    let rows = token_rows(&h).await;

    *offset.lock().unwrap() += Duration::from_secs(61);

    assert_eq!(poll(&h, &code, &secret).await["status"], "expired");
    assert_eq!(token_rows(&h).await, rows);
}

#[tokio::test]
async fn approve_requires_a_token() {
    let h = harness().await;
    let (code, _) = start(&h).await;
    let (status, _) = post(&h, APPROVE, None, json!({ "code": code, "name": "TV" })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = post(&h, DENY, None, json!({ "code": code })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn lookup_requires_a_token() {
    let h = harness().await;
    let (code, _) = start(&h).await;
    let (status, _) = post(&h, LOOKUP, None, json!({ "code": code })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn lookup_describes_the_requesting_screen() {
    let h = harness().await;
    let ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    let (status, body) = send(
        &h.app,
        axum::http::Request::builder()
            .method("POST")
            .uri(START)
            .header("content-type", "application/json")
            .header("user-agent", ua)
            .body(axum::body::Body::from("{}"))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let code = body["code"].as_str().unwrap();

    let (status, info) = post(&h, LOOKUP, Some(&h.token), json!({ "code": code })).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["userAgent"], ua);
    assert_eq!(info["suggestedName"], "Chrome on Linux");
    assert!(info["ageSeconds"].as_u64().unwrap() < 5);

    let (status, _) = post(&h, LOOKUP, Some(&h.token), json!({ "code": "nope" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deny_reaches_the_waiting_screen() {
    let h = harness().await;
    let (code, secret) = start(&h).await;
    let (status, _) = post(&h, DENY, Some(&h.token), json!({ "code": code })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(poll(&h, &code, &secret).await["status"], "denied");
}

#[tokio::test]
async fn double_approve_is_409_and_mints_nothing() {
    let h = harness().await;
    let (code, secret) = start(&h).await;
    assert_eq!(approve(&h, &code, "TV").await.0, StatusCode::OK);

    let (status, body) = approve(&h, &code, "TV").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "not_pending");

    poll(&h, &code, &secret).await;
    assert_eq!(token_rows(&h).await, 2, "initial token plus one screen");
}

#[tokio::test]
async fn bad_names_are_rejected() {
    let h = harness().await;
    let (code, _) = start(&h).await;
    assert_eq!(approve(&h, &code, "   ").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        approve(&h, &code, &"x".repeat(61)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(approve(&h, &code, "  Kitchen  ").await.0, StatusCode::OK);
}

#[tokio::test]
async fn approved_token_has_no_expiry_and_carries_the_chosen_name() {
    let h = harness().await;
    let (code, secret) = start(&h).await;
    approve(&h, &code, "Kitchen TV").await;
    poll(&h, &code, &secret).await;

    let (name, expires, active): (String, Option<String>, i64) =
        sqlx::query_as("SELECT name, expires, active FROM tokens WHERE name = 'Kitchen TV'")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(name, "Kitchen TV");
    assert!(expires.is_none(), "screen tokens never expire");
    assert_eq!(active, 1);
}

#[tokio::test]
async fn start_flood_hits_429_at_the_cap() {
    let h = harness().await;
    for _ in 0..flatline_backend::device::MAX_PENDING {
        start(&h).await;
    }
    let (status, body) = post(&h, START, None, json!({})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"], "busy");
}

#[tokio::test]
async fn agent_tokens_cannot_approve() {
    let h = harness().await;
    let (code, _) = start(&h).await;
    let (status, _) = post(
        &h,
        APPROVE,
        Some("flatline_agent_push_deadbeef"),
        json!({ "code": code, "name": "TV" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn openapi_documents_device_routes() {
    let h = harness().await;
    let (_, body) = send(
        &h.app,
        request("GET", "/api/v1/openapi.json", Some(&h.token), None),
    )
    .await;
    let paths = body["paths"].as_object().unwrap();
    for path in [START, POLL, LOOKUP, APPROVE, DENY] {
        assert!(paths.contains_key(path), "{path} is missing from OpenAPI");
    }
}
