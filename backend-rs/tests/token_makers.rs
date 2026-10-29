//! Tokens remember who made them, and removing a member can revoke them.

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{Harness, add_member, get_json, harness, request, send, sign_in, with_cookie};

const START: &str = "starting pw 1";
const OWN: &str = "my own password";

/// A member who has chosen their own password; returns (id, session).
async fn settled_member(h: &Harness, email: &str, name: &str) -> (i64, String) {
    let id = add_member(h, email, name, START).await;
    let session = sign_in(&h.app, json!({ "email": email, "password": START })).await;
    let (status, body) = send(
        &h.app,
        with_cookie(
            "POST",
            "/api/v1/auth/password",
            &session,
            Some(json!({ "currentPassword": START, "newPassword": OWN })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (id, session)
}

/// Mint a key with the member's cookie; returns (id, token).
async fn mint_as(h: &Harness, session: &str, name: &str) -> (i64, String) {
    let (status, body) = send(
        &h.app,
        with_cookie("POST", "/api/v1/api-keys", session, Some(json!({ "name": name }))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (
        body["apiKey"]["id"].as_i64().unwrap(),
        body["token"].as_str().unwrap().to_string(),
    )
}

/// The `maker` of the key named `name` in `GET /api-keys`.
async fn maker_of(h: &Harness, name: &str) -> Value {
    let (status, body) = get_json(&h.app, "/api/v1/api-keys", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    body["apiKeys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["name"] == name)
        .unwrap_or_else(|| panic!("no key named {name}: {body}"))["maker"]
        .clone()
}

fn remove(id: i64, revoke: &[i64]) -> axum::http::Request<axum::body::Body> {
    request(
        "DELETE",
        &format!("/api/v1/users/{id}"),
        None,
        Some(json!({ "revokeTokenIds": revoke })),
    )
}

fn bearer(mut req: axum::http::Request<axum::body::Body>, token: &str) -> axum::http::Request<axum::body::Body> {
    req.headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    req
}

#[tokio::test]
async fn a_token_minted_by_a_member_names_them() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    mint_as(&h, &session, "ana laptop").await;
    assert_eq!(
        maker_of(&h, "ana laptop").await,
        json!({ "id": id, "name": "Ana", "removed": false })
    );

    let (status, _) = send(
        &h.app,
        request("POST", "/api/v1/api-keys", Some(&h.token), Some(json!({ "name": "ci" }))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(maker_of(&h, "ci").await, Value::Null);
    assert_eq!(maker_of(&h, "admin").await, Value::Null);

    // A token session has no account to name either.
    let token_session = sign_in(&h.app, json!({ "token": h.token })).await;
    mint_as(&h, &token_session, "via token session").await;
    assert_eq!(maker_of(&h, "via token session").await, Value::Null);

    let (_, body) = get_json(&h.app, "/api/v1/users", &h.token).await;
    assert_eq!(body["users"][0]["tokenCount"], 1);
}

#[tokio::test]
async fn a_renamed_member_is_shown_by_their_new_name() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    mint_as(&h, &session, "ana laptop").await;
    send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/users/{id}"),
            Some(&h.token),
            Some(json!({ "name": "Ana Bek" })),
        ),
    )
    .await;
    assert_eq!(maker_of(&h, "ana laptop").await["name"], "Ana Bek");
}

#[tokio::test]
async fn a_screen_paired_by_a_member_names_them() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    let (_, started) = send(
        &h.app,
        request("POST", "/api/v1/auth/device/start", None, Some(json!({}))),
    )
    .await;
    let code = started["code"].as_str().unwrap();
    let secret = started["pollSecret"].as_str().unwrap();

    let (status, body) = send(
        &h.app,
        with_cookie(
            "POST",
            "/api/v1/auth/device/approve",
            &session,
            Some(json!({ "code": code, "name": "Wall TV" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, polled) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/device/poll",
            None,
            Some(json!({ "code": code, "pollSecret": secret })),
        ),
    )
    .await;
    assert_eq!(polled["status"], "approved");
    assert_eq!(
        maker_of(&h, "Wall TV").await,
        json!({ "id": id, "name": "Ana", "removed": false })
    );

    let (_, body) = get_json(&h.app, &format!("/api/v1/users/{id}"), &h.token).await;
    assert_eq!(body["tokens"][0]["name"], "Wall TV");
    assert_eq!(body["tokens"][0]["active"], true);
}

#[tokio::test]
async fn removing_a_member_revokes_the_tokens_chosen() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    let (k1, t1) = mint_as(&h, &session, "k1").await;
    let (_, t2) = mint_as(&h, &session, "k2").await;
    let tv_session = sign_in(&h.app, json!({ "token": t1 })).await;

    let (status, body) = send(&h.app, bearer(remove(id, &[k1]), &h.token)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revokedTokens"], 1);

    let (status, _) = get_json(&h.app, "/api/v1/monitors", &t1).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/monitors", &tv_session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the revoked token's session ends");
    let (status, _) = get_json(&h.app, "/api/v1/monitors", &t2).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        maker_of(&h, "k2").await,
        json!({ "id": null, "name": "Ana", "removed": true })
    );

    // Their own browser is signed out.
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = get_json(&h.app, &format!("/api/v1/users/{id}"), &h.token).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn removing_a_member_without_a_body_keeps_their_tokens() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    let (_, token) = mint_as(&h, &session, "k1").await;
    let (status, body) = send(
        &h.app,
        request("DELETE", &format!("/api/v1/users/{id}"), Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revokedTokens"], 0);
    let (status, _) = get_json(&h.app, "/api/v1/monitors", &token).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn only_their_own_tokens_can_be_revoked_with_them() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    let (k1, _) = mint_as(&h, &session, "k1").await;
    let admin_id: i64 = sqlx::query_scalar("SELECT id FROM tokens WHERE name = 'admin'")
        .fetch_one(&h.pool)
        .await
        .unwrap();

    let (status, body) = send(&h.app, bearer(remove(id, &[k1, admin_id]), &h.token)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "bad_request");

    // Nothing happened: the account and both tokens remain.
    let (status, _) = get_json(&h.app, &format!("/api/v1/users/{id}"), &h.token).await;
    assert_eq!(status, StatusCode::OK);
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tokens WHERE active = 1")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(active, 2);
}

#[tokio::test]
async fn nobody_removes_their_own_account() {
    let h = harness().await;
    let (id, session) = settled_member(&h, "ana@office.kz", "Ana").await;
    let (status, body) = send(
        &h.app,
        with_cookie(
            "DELETE",
            &format!("/api/v1/users/{id}"),
            &session,
            Some(json!({ "revokeTokenIds": [] })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "cannot_remove_self");

    // Someone else may.
    let (other, other_session) = settled_member(&h, "bek@office.kz", "Bek").await;
    assert_ne!(other, id);
    let (status, _) = send(
        &h.app,
        with_cookie("DELETE", &format!("/api/v1/users/{id}"), &other_session, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn removing_the_last_account_is_allowed() {
    let h = harness().await;
    let (id, _) = settled_member(&h, "ana@office.kz", "Ana").await;
    let (status, _) = send(
        &h.app,
        request("DELETE", &format!("/api/v1/users/{id}"), Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = send(&h.app, request("GET", "/api/v1/auth/setup", None, None)).await;
    assert_eq!(body["setupNeeded"], true);
    let (status, _) = get_json(&h.app, "/api/v1/monitors", &h.token).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn removing_an_unknown_member_is_not_found() {
    let h = harness().await;
    let (status, _) = send(
        &h.app,
        request("DELETE", "/api/v1/users/9999", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
