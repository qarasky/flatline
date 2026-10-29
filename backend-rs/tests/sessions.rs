//! Server-side sessions behind the `fl_session` cookie: email/password and
//! token sign-in, signing out, and everything that ends a session.

use axum::http::StatusCode;
use serde_json::json;

mod common;
use common::{add_member, harness, request, send, send_full, sign_in, with_cookie};
use flatline_backend::auth::{self, Credential};

const PASSWORD: &str = "correct horse";

async fn member_session(h: &common::Harness) -> (i64, String) {
    let id = add_member(h, "Ana@Office.kz", "Ana", PASSWORD).await;
    let session = sign_in(&h.app, json!({ "email": "ana@office.kz", "password": PASSWORD })).await;
    (id, session)
}

async fn mint(h: &common::Harness, name: &str) -> (i64, String) {
    let (status, body) = send(
        &h.app,
        request("POST", "/api/v1/api-keys", Some(&h.token), Some(json!({ "name": name }))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    (
        body["apiKey"]["id"].as_i64().unwrap(),
        body["token"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn signing_in_with_email_and_password_sets_a_session() {
    let h = harness().await;
    add_member(&h, "Ana@Office.kz", "Ana", PASSWORD).await;
    let (status, cookie, body) = send_full(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/session",
            None,
            Some(json!({ "email": "ana@office.kz", "password": PASSWORD })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["principal"], "account");
    assert_eq!(body["mustChangePassword"], true);
    let cookie = cookie.unwrap();
    assert!(cookie.starts_with("fl_session=fls_"), "{cookie}");
    let session = common::cookie_value(&cookie);
    assert_eq!(session.len(), 4 + 64);

    let (status, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["principal"], "account");
    assert_eq!(body["account"]["email"], "Ana@Office.kz");
    assert_eq!(body["account"]["name"], "Ana");
    assert_eq!(body["account"]["mustChangePassword"], true);
    assert!(body["account"]["id"].as_i64().is_some());
}

#[tokio::test]
async fn sessions_are_stored_hashed() {
    let h = harness().await;
    let (_, session) = member_session(&h).await;
    let stored: String = sqlx::query_scalar("SELECT hash FROM sessions")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(stored, auth::hash_token(&session));
}

#[tokio::test]
async fn a_wrong_password_and_an_unknown_email_answer_alike() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", PASSWORD).await;
    let attempt = |email: &str, password: &str| {
        request(
            "POST",
            "/api/v1/auth/session",
            None,
            Some(json!({ "email": email, "password": password })),
        )
    };
    let (wrong_status, wrong_cookie, wrong) =
        send_full(&h.app, attempt("ana@office.kz", "not the password")).await;
    let (unknown_status, unknown_cookie, unknown) =
        send_full(&h.app, attempt("nobody@office.kz", PASSWORD)).await;
    assert_eq!(wrong_status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown_status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong, unknown);
    assert_eq!(wrong["error"], "unauthorized");
    assert!(wrong_cookie.is_none() && unknown_cookie.is_none());
}

#[tokio::test]
async fn a_token_session_reports_its_token() {
    let h = harness().await;
    let (status, cookie, body) = send_full(
        &h.app,
        request("POST", "/api/v1/auth/session", None, Some(json!({ "token": h.token }))),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["principal"], "token");
    let session = common::cookie_value(&cookie.unwrap());
    assert!(session.starts_with("fls_"));
    assert!(!session.contains(&h.token));

    let (_, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(body["principal"], "token");
    assert_eq!(body["token"]["name"], "admin");
    assert!(body["token"]["id"].as_i64().is_some());
}

#[tokio::test]
async fn a_bearer_token_reports_itself() {
    let h = harness().await;
    let (status, body) = common::get_json(&h.app, "/api/v1/auth/me", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["principal"], "token");
    assert_eq!(body["token"]["name"], "admin");
}

#[tokio::test]
async fn signing_out_ends_the_session_server_side() {
    let h = harness().await;
    let (_, session) = member_session(&h).await;
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(&h.app, with_cookie("DELETE", "/api/v1/auth/session", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn removing_an_account_ends_its_sessions() {
    let h = harness().await;
    let (id, session) = member_session(&h).await;
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn disabling_a_token_ends_sessions_made_with_it() {
    let h = harness().await;
    let (id, token) = mint(&h, "tv").await;
    let session = sign_in(&h.app, json!({ "token": token })).await;
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
async fn deleting_or_expiring_a_token_ends_sessions_made_with_it() {
    let h = harness().await;
    let (id, token) = mint(&h, "tv").await;
    let session = sign_in(&h.app, json!({ "token": token })).await;
    let (status, _) = send(
        &h.app,
        request("DELETE", &format!("/api/v1/api-keys/{id}"), Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (id, token) = mint(&h, "tv 2").await;
    let session = sign_in(&h.app, json!({ "token": token })).await;
    sqlx::query("UPDATE tokens SET expires = '2020-01-01 00:00:00' WHERE id = ?")
        .bind(id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_account_session_lapses_after_thirty_idle_days() {
    let h = harness().await;
    let (_, session) = member_session(&h).await;

    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-29 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    let fresh: i64 = sqlx::query_scalar(
        "SELECT last_used_at > datetime('now', '-1 minute') FROM sessions",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(fresh, 1, "a used session slides forward");

    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-31 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_token_session_lasts_four_hundred_idle_days() {
    let h = harness().await;
    let session = sign_in(&h.app, json!({ "token": h.token })).await;
    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-399 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-401 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_stream_drops_a_removed_account() {
    // The stream revalidates its credential every 15 s with `still_valid`;
    // its ticker runs on real time, so assert the check it relies on.
    let h = harness().await;
    let (id, session) = member_session(&h).await;
    let credential = Credential::Session(session.clone());
    assert_eq!(auth::still_valid(&h.pool, &credential).await, Ok(true));

    let response = tower::ServiceExt::oneshot(
        h.app.clone(),
        with_cookie("GET", "/api/v1/events", &session, None),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(&h.pool)
        .await
        .unwrap();
    assert_eq!(auth::still_valid(&h.pool, &credential).await, Ok(false));
    assert_eq!(
        auth::still_valid(&h.pool, &Credential::Bearer(h.token.clone())).await,
        Ok(true)
    );
}
