//! Kore ID is the only browser sign-in. The password, setup and
//! operator-token sign-in routes are gone; bearer tokens remain API-only.

use axum::http::StatusCode;
use serde_json::json;

mod common;
use common::{harness, request, send};

#[tokio::test]
async fn password_setup_and_token_login_routes_are_gone() {
    let h = harness().await;
    for (method, uri) in [
        ("GET", "/api/v1/auth/setup"),
        ("POST", "/api/v1/auth/setup"),
        ("POST", "/api/v1/auth/login"),
        ("POST", "/api/v1/auth/password"),
        ("POST", "/api/v1/users/1/reset-password"),
        ("POST", "/api/v1/auth/device/start"),
        ("POST", "/api/v1/auth/device/poll"),
    ] {
        let (status, _) = send(&h.app, request(method, uri, None, Some(json!({})))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
    }

    // The session route exists only to sign out.
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/session",
            None,
            Some(json!({ "token": h.token })),
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::METHOD_NOT_ALLOWED,
        "no token or password sign-in"
    );
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/session",
            None,
            Some(json!({ "email": "a@b.kz", "password": "correct horse" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

    // Inviting with a password is gone too.
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/users",
            Some(&h.token),
            Some(json!({ "email": "a@b.kz", "name": "A", "password": "correct horse" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn sso_config_has_no_password_or_token_switches() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/auth/sso/config", None, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sso"], false);
    assert_eq!(body["provider"], "Kore ID");
    assert!(body.get("localLogin").is_none(), "{body}");
    assert!(body.get("tokenLogin").is_none(), "{body}");
}

#[tokio::test]
async fn a_bearer_token_still_works_but_never_becomes_a_cookie() {
    let h = harness().await;
    let (status, _) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/session",
            None,
            Some(json!({ "token": h.token })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}
