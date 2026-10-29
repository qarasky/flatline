//! The web app's cookie session: `POST/DELETE /api/v1/auth/session`, the
//! `fl_session` cookie on `/api/v1`, and the CSRF rule for cookie writes.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{harness, next_sse_data, request, send, send_full, sign_in, with_bare_cookie, with_cookie};

fn session_request(token: &str) -> Request<Body> {
    request(
        "POST",
        "/api/v1/auth/session",
        None,
        Some(json!({ "token": token })),
    )
}

#[tokio::test]
async fn session_sets_an_httponly_lax_cookie() {
    let h = harness().await;
    let (status, cookie, body) = send_full(&h.app, session_request(&h.token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    let cookie = cookie.expect("a session cookie");
    assert!(cookie.starts_with("fl_session=fls_"), "{cookie}");
    assert!(!cookie.contains(&h.token), "the cookie never carries the token: {cookie}");
    for part in ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=34560000"] {
        assert!(cookie.contains(part), "missing {part}: {cookie}");
    }
    assert!(!cookie.contains("Secure"), "plain HTTP gets no Secure: {cookie}");
}

#[tokio::test]
async fn session_cookie_is_secure_behind_https() {
    let h = harness().await;
    let mut req = session_request(&h.token);
    req.headers_mut()
        .insert("x-forwarded-proto", "https".parse().unwrap());
    let (status, cookie, _) = send_full(&h.app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(cookie.unwrap().contains("Secure"));
}

#[tokio::test]
async fn session_refuses_a_bad_token_without_a_cookie() {
    let h = harness().await;
    let (status, cookie, body) = send_full(&h.app, session_request("flatline_op_nope")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
    assert!(cookie.is_none());
}

#[tokio::test]
async fn session_refuses_an_agent_token_explicitly() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "edge", "type": "push" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let push = body["monitor"]["pushToken"].as_str().unwrap().to_string();

    let (status, cookie, body) = send_full(&h.app, session_request(&push)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");
    assert!(cookie.is_none());
}

#[tokio::test]
async fn the_cookie_authenticates_reads() {
    let h = harness().await;
    let session = sign_in(&h.app, json!({ "token": h.token })).await;
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_token_in_the_cookie_is_not_a_session() {
    let h = harness().await;
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &h.token, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_revoked_token_in_the_cookie_is_refused() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/api-keys",
            Some(&h.token),
            Some(json!({ "name": "tv" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["apiKey"]["id"].as_i64().unwrap();
    let minted = body["token"].as_str().unwrap().to_string();
    let session = sign_in(&h.app, json!({ "token": minted })).await;

    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/api-keys/{id}"),
            Some(&h.token),
            Some(json!({ "active": false })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn cookie_writes_need_the_csrf_header() {
    let h = harness().await;
    let session = sign_in(&h.app, json!({ "token": h.token })).await;
    let group = || Some(json!({ "name": "g", "type": "group" }));

    let (status, body) = send(&h.app, with_bare_cookie("POST", "/api/v1/monitors", &session, group())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "csrf_required");

    let (status, _) = send(&h.app, with_cookie("POST", "/api/v1/monitors", &session, group())).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = send(
        &h.app,
        request("POST", "/api/v1/monitors", Some(&h.token), group()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn the_event_stream_accepts_the_cookie() {
    let h = harness().await;
    let session = sign_in(&h.app, json!({ "token": h.token })).await;
    let response = h
        .app
        .clone()
        .oneshot(with_cookie("GET", "/api/v1/events", &session, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let frame = next_sse_data(&mut body).await;
    assert!(frame.is_object());
}

#[tokio::test]
async fn deleting_the_session_clears_the_cookie() {
    let h = harness().await;
    let (status, cookie, body) = send_full(
        &h.app,
        request("DELETE", "/api/v1/auth/session", None, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    let cookie = cookie.expect("a clearing cookie");
    assert!(cookie.starts_with("fl_session=;"), "{cookie}");
    assert!(cookie.contains("Max-Age=0"), "{cookie}");
}
