//! Password rules: the must-change gate, changing and resetting passwords,
//! the starting-password expiry, sign-in limits and the first account.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};

mod common;
use common::{
    Harness, add_member, cookie_value, harness, request, send, send_full, sign_in, with_cookie,
};

const START: &str = "starting pw 1";
const OWN: &str = "my own password";

fn credentials(email: &str, password: &str) -> Value {
    json!({ "email": email, "password": password })
}

fn sign_in_request(email: &str, password: &str) -> Request<Body> {
    request(
        "POST",
        "/api/v1/auth/session",
        None,
        Some(credentials(email, password)),
    )
}

fn from_address(mut req: Request<Body>, address: &str) -> Request<Body> {
    req.headers_mut()
        .insert("cf-connecting-ip", address.parse().unwrap());
    req
}

fn change(session: &str, current: &str, new: &str) -> Request<Body> {
    with_cookie(
        "POST",
        "/api/v1/auth/password",
        session,
        Some(json!({ "currentPassword": current, "newPassword": new })),
    )
}

/// A member who has chosen their own password; returns (id, session).
async fn settled_member(h: &Harness) -> (i64, String) {
    let id = add_member(h, "ana@office.kz", "Ana", START).await;
    let session = sign_in(&h.app, credentials("ana@office.kz", START)).await;
    let (status, body) = send(&h.app, change(&session, START, OWN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (id, session)
}

#[tokio::test]
async fn a_starting_password_only_opens_the_change_password_door() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let session = sign_in(&h.app, credentials("ana@office.kz", START)).await;

    let (status, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["account"]["mustChangePassword"], true);

    for req in [
        with_cookie("GET", "/api/v1/monitors", &session, None),
        with_cookie("GET", "/api/v1/users", &session, None),
        with_cookie(
            "POST",
            "/api/v1/monitors",
            &session,
            Some(json!({ "name": "g", "type": "group" })),
        ),
        with_cookie("GET", "/api/v1/events", &session, None),
    ] {
        let uri = req.uri().to_string();
        let (status, body) = send(&h.app, req).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(body["error"], "password_change_required", "{uri}");
        assert!(body["hint"].as_str().unwrap().contains("/api/v1/auth/password"));
    }
}

#[tokio::test]
async fn changing_the_password_lifts_the_gate_and_ends_other_sessions() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let a = sign_in(&h.app, credentials("ana@office.kz", START)).await;
    let b = sign_in(&h.app, credentials("ana@office.kz", START)).await;

    let (status, body) = send(&h.app, change(&a, START, OWN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);

    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &a, None)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &b, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The new password signs in, the starting one no longer does.
    let (status, _, body) = send_full(&h.app, sign_in_request("ana@office.kz", OWN)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["mustChangePassword"], false);
    let (status, _, _) = send_full(&h.app, sign_in_request("ana@office.kz", START)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn changing_needs_the_current_password_and_a_long_new_one() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let session = sign_in(&h.app, credentials("ana@office.kz", START)).await;

    let (status, body) = send(&h.app, change(&session, "not the current one", OWN)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "wrong_password");

    let (status, body) = send(&h.app, change(&session, START, "short")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "weak_password");

    // Still gated: neither attempt changed anything.
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn changing_the_password_needs_the_csrf_header() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let session = sign_in(&h.app, credentials("ana@office.kz", START)).await;
    let (status, body) = send(
        &h.app,
        common::with_bare_cookie(
            "POST",
            "/api/v1/auth/password",
            &session,
            Some(json!({ "currentPassword": START, "newPassword": OWN })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "csrf_required");
}

#[tokio::test]
async fn a_bearer_token_has_no_password_to_change() {
    let h = harness().await;
    let body = Some(json!({ "currentPassword": START, "newPassword": OWN }));
    let (status, body) = send(
        &h.app,
        request("POST", "/api/v1/auth/password", Some(&h.token), body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "not_an_account");

    let session = sign_in(&h.app, json!({ "token": h.token })).await;
    let (status, body) = send(&h.app, change(&session, START, OWN)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "not_an_account");
}

#[tokio::test]
async fn resetting_a_password_ends_sessions() {
    let h = harness().await;
    let (id, session) = settled_member(&h).await;
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/users/{id}/reset-password"),
            Some(&h.token),
            Some(json!({ "password": "another start pw" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["user"]["mustChangePassword"], true);

    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, body) =
        send_full(&h.app, sign_in_request("ana@office.kz", "another start pw")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["mustChangePassword"], true);
}

#[tokio::test]
async fn an_expired_starting_password_is_refused_with_a_reason() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    sqlx::query("UPDATE users SET password_set_at = datetime('now', '-8 days')")
        .execute(&h.pool)
        .await
        .unwrap();

    let (status, cookie, body) = send_full(&h.app, sign_in_request("ana@office.kz", START)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "starting_password_expired");
    assert_eq!(body["message"], "Ask someone to reset your password.");
    assert!(cookie.is_none());

    let (status, _, body) =
        send_full(&h.app, sign_in_request("ana@office.kz", "not the password")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}

#[tokio::test]
async fn the_sixth_failure_for_an_email_is_throttled() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    for _ in 0..5 {
        let (status, _, _) = send_full(&h.app, sign_in_request("ana@office.kz", "wrong guess")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // Even the right password waits, and case does not dodge the limit.
    let (status, cookie, body) = send_full(&h.app, sign_in_request("ANA@office.kz", START)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"], "rate_limited");
    assert!(body["retryAfterSeconds"].as_u64().unwrap() > 0);
    assert!(cookie.is_none());

    // Another member is not affected.
    add_member(&h, "bek@office.kz", "Bek", START).await;
    let (status, _, _) = send_full(&h.app, sign_in_request("bek@office.kz", START)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_successful_sign_in_clears_the_email_count() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    for _ in 0..4 {
        send_full(&h.app, sign_in_request("ana@office.kz", "wrong guess")).await;
    }
    let (status, _, _) = send_full(&h.app, sign_in_request("ana@office.kz", START)).await;
    assert_eq!(status, StatusCode::OK);
    for _ in 0..4 {
        send_full(&h.app, sign_in_request("ana@office.kz", "wrong guess")).await;
    }
    let (status, _, _) = send_full(&h.app, sign_in_request("ana@office.kz", START)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn one_address_is_throttled_across_emails() {
    let h = harness().await;
    for n in 0..20 {
        let req = from_address(
            sign_in_request(&format!("nobody{n}@office.kz"), "wrong guess"),
            "203.0.113.9",
        );
        let (status, _, _) = send_full(&h.app, req).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {n}");
    }
    let req = from_address(sign_in_request("nobody99@office.kz", "wrong guess"), "203.0.113.9");
    let (status, _, body) = send_full(&h.app, req).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"], "rate_limited");

    let req = from_address(sign_in_request("nobody99@office.kz", "wrong guess"), "198.51.100.7");
    let (status, _, _) = send_full(&h.app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_first_account_needs_an_operator_token() {
    let h = harness().await;
    let setup = |token: Option<&str>| {
        let mut body = json!({ "email": "me@office.kz", "name": "Me", "password": OWN });
        if let Some(token) = token {
            body["token"] = json!(token);
        }
        request("POST", "/api/v1/auth/setup", None, Some(body))
    };

    let (status, body) = send(&h.app, request("GET", "/api/v1/auth/setup", None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["setupNeeded"], true);

    let (status, cookie, _) = send_full(&h.app, setup(None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(cookie.is_none());
    let (status, _, _) = send_full(&h.app, setup(Some("flatline_op_nope"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, cookie, body) = send_full(&h.app, setup(Some(&h.token))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let session = cookie_value(&cookie.expect("the first account is signed in"));
    let (status, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["principal"], "account");
    assert_eq!(body["account"]["mustChangePassword"], false);
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &session, None)).await;
    assert_eq!(status, StatusCode::OK);

    let (_, body) = send(&h.app, request("GET", "/api/v1/auth/setup", None, None)).await;
    assert_eq!(body["setupNeeded"], false);
    let (status, _, body) = send_full(&h.app, setup(Some(&h.token))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "setup_done");
}

#[tokio::test]
async fn the_first_account_refuses_an_agent_token() {
    let h = harness().await;
    let (_, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "edge", "type": "push" })),
        ),
    )
    .await;
    let push = body["monitor"]["pushToken"].as_str().unwrap();
    let (status, _, body) = send_full(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/setup",
            None,
            Some(json!({ "token": push, "email": "me@office.kz", "name": "Me", "password": OWN })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_wrong_guesses_cannot_outrun_the_limit() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let guesses: Vec<_> = (0..20)
        .map(|_| {
            let app = h.app.clone();
            tokio::spawn(async move {
                send_full(&app, sign_in_request("ana@office.kz", "wrong guess")).await.0
            })
        })
        .collect();
    let mut checked = 0;
    for guess in guesses {
        let status = guess.await.unwrap();
        if status == StatusCode::UNAUTHORIZED {
            checked += 1;
        } else {
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        }
    }
    assert_eq!(checked, 5, "only five guesses are checked, however they arrive");
}

#[tokio::test]
async fn a_successful_sign_in_does_not_use_the_address_budget() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    for n in 0..19 {
        let req = from_address(
            sign_in_request(&format!("nobody{n}@office.kz"), "wrong guess"),
            "203.0.113.9",
        );
        send_full(&h.app, req).await;
    }
    let req = from_address(sign_in_request("ana@office.kz", START), "203.0.113.9");
    let (status, _, _) = send_full(&h.app, req).await;
    assert_eq!(status, StatusCode::OK);
    // The twentieth failure is still checked.
    let req = from_address(sign_in_request("nobody99@office.kz", "wrong guess"), "203.0.113.9");
    let (status, _, _) = send_full(&h.app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_new_password_must_differ_from_the_current_one() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let session = sign_in(&h.app, credentials("ana@office.kz", START)).await;
    let (status, body) = send(&h.app, change(&session, START, START)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "same_password");
    let (_, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(body["account"]["mustChangePassword"], true);
}

#[tokio::test]
async fn an_expired_starting_password_cannot_be_changed_from_an_open_session() {
    let h = harness().await;
    add_member(&h, "ana@office.kz", "Ana", START).await;
    let session = sign_in(&h.app, credentials("ana@office.kz", START)).await;
    sqlx::query("UPDATE users SET password_set_at = datetime('now', '-8 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, body) = send(&h.app, change(&session, START, OWN)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"], "starting_password_expired");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_one_first_account_is_created() {
    let h = harness().await;
    let attempts: Vec<_> = (0..8)
        .map(|n| {
            let app = h.app.clone();
            let token = h.token.clone();
            tokio::spawn(async move {
                let body = json!({ "token": token, "email": format!("me{n}@office.kz"), "name": "Me", "password": OWN });
                send_full(&app, request("POST", "/api/v1/auth/setup", None, Some(body))).await.0
            })
        })
        .collect();
    let mut created = 0;
    for attempt in attempts {
        match attempt.await.unwrap() {
            StatusCode::OK => created += 1,
            status => assert_eq!(status, StatusCode::CONFLICT),
        }
    }
    assert_eq!(created, 1);
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(accounts, 1);
}
