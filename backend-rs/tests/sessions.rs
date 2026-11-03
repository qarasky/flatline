//! Server-side sessions behind the `fl_session` cookie: account sessions
//! created by Kore ID, signing out, and everything that ends a session.

use axum::http::StatusCode;

mod common;
use common::{add_account, harness, request, send, session_for, with_cookie};
use flatline_backend::auth::{self, Credential};

/// Whether the session's last use was recorded within the last minute,
/// waiting up to a second: the touch runs off the request path.
async fn touched(pool: &sqlx::SqlitePool) -> bool {
    for _ in 0..50 {
        let fresh: i64 =
            sqlx::query_scalar("SELECT last_used_at > datetime('now', '-1 minute') FROM sessions")
                .fetch_one(pool)
                .await
                .unwrap();
        if fresh == 1 {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    false
}

/// An account with a browser session, as a Kore ID sign-in creates it.
async fn member_session(h: &common::Harness) -> (i64, String) {
    let id = add_account(h, "Ana@Office.kz", "Ana").await;
    (id, session_for(h, id).await)
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
async fn an_account_session_reports_its_account() {
    let h = harness().await;
    let (id, session) = member_session(&h).await;
    let (status, body) = send(
        &h.app,
        with_cookie("GET", "/api/v1/auth/me", &session, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["principal"], "account");
    assert_eq!(body["account"]["id"], id);
    assert_eq!(body["account"]["email"], "Ana@Office.kz");
    assert_eq!(body["account"]["name"], "Ana");
    assert!(body["account"].get("mustChangePassword").is_none());
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
    let (status, _) = send(
        &h.app,
        with_cookie("GET", "/api/v1/auth/me", &session, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &h.app,
        with_cookie("DELETE", "/api/v1/auth/session", &session, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &h.app,
        with_cookie("GET", "/api/v1/auth/me", &session, None),
    )
    .await;
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
    let (status, _) = send(
        &h.app,
        with_cookie("GET", "/api/v1/auth/me", &session, None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn legacy_token_sessions_are_refused() {
    let h = harness().await;
    let token_id: i64 = sqlx::query_scalar("SELECT id FROM tokens WHERE name = 'admin'")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let raw = "fls_legacy_token_session";
    sqlx::query("INSERT INTO sessions (hash, token_id) VALUES (?, ?)")
        .bind(auth::hash_token(raw))
        .bind(token_id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", raw, None)).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "only Kore ID creates browser sessions"
    );
    // The token itself still authenticates the API as a bearer.
    let (status, _) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_account_session_lapses_after_thirty_idle_days() {
    let h = harness().await;
    let (_, session) = member_session(&h).await;

    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-29 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(
        &h.app,
        with_cookie("GET", "/api/v1/auth/me", &session, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(touched(&h.pool).await, "a used session slides forward");

    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-31 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = send(
        &h.app,
        with_cookie("GET", "/api/v1/auth/me", &session, None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_stream_drops_a_removed_account() {
    // The stream revalidates its credential every 15 s with `still_valid`;
    // its ticker runs on real time, so assert the check it relies on.
    let h = harness().await;
    let (id, session) = member_session(&h).await;
    let credential = Credential::Session(session.clone());
    assert_eq!(
        auth::still_valid(&h.pool, None, &credential).await,
        Ok(true)
    );

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
    assert_eq!(
        auth::still_valid(&h.pool, None, &credential).await,
        Ok(false)
    );
    assert_eq!(
        auth::still_valid(&h.pool, None, &Credential::Bearer(h.token.clone())).await,
        Ok(true)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_database_does_not_fail_a_valid_session() {
    let h = harness().await;
    let (_, session) = member_session(&h).await;
    sqlx::query("UPDATE sessions SET last_used_at = datetime('now', '-2 minutes')")
        .execute(&h.pool)
        .await
        .unwrap();

    // Another writer holds the lock (the check engine, a big import).
    let mut writer = h.pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *writer)
        .await
        .unwrap();
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        send(
            &h.app,
            with_cookie("GET", "/api/v1/auth/me", &session, None),
        ),
    )
    .await;
    sqlx::query("ROLLBACK").execute(&mut *writer).await.unwrap();
    let (status, _) = answer.expect("the request does not wait for the write lock");
    assert_eq!(status, StatusCode::OK);
}
