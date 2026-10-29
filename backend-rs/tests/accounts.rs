//! Member accounts: `/api/v1/users`, email uniqueness, password rules and
//! the starting-password expiry.

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{get_json, harness, request, send};

async fn add(h: &common::Harness, email: &str, name: &str, password: &str) -> (StatusCode, Value) {
    send(
        &h.app,
        request(
            "POST",
            "/api/v1/users",
            Some(&h.token),
            Some(json!({ "email": email, "name": name, "password": password })),
        ),
    )
    .await
}

#[tokio::test]
async fn adding_a_member_returns_them_without_the_password() {
    let h = harness().await;
    let (status, body) = add(&h, "Ana@Office.kz", "Ana", "correct horse").await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["ok"], true);
    let user = &body["user"];
    assert_eq!(user["email"], "Ana@Office.kz");
    assert_eq!(user["name"], "Ana");
    assert_eq!(user["mustChangePassword"], true);
    assert_eq!(user["startingPasswordExpired"], false);
    assert!(user["id"].as_i64().is_some());
    let text = body.to_string();
    assert!(!text.contains("password\""), "{text}");
    assert!(!text.contains("passwordHash"), "{text}");
    assert!(!text.contains("correct horse"), "{text}");
}

#[tokio::test]
async fn emails_are_unique_ignoring_case() {
    let h = harness().await;
    assert_eq!(add(&h, "Ana@Office.kz", "Ana", "correct horse").await.0, StatusCode::CREATED);
    let (status, body) = add(&h, "ana@office.kz", "Other Ana", "correct horse").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "email_taken");
}

#[tokio::test]
async fn short_passwords_are_refused() {
    let h = harness().await;
    let (status, body) = add(&h, "a@office.kz", "Ana", "123456789").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "weak_password");
    let (status, _) = add(&h, "a@office.kz", "Ana", "1234567890").await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn bad_emails_and_names_are_refused() {
    let h = harness().await;
    for email in ["ana", "@x", "a@", "a@b@c", "  "] {
        let (status, body) = add(&h, email, "Ana", "correct horse").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{email}: {body}");
        assert_eq!(body["error"], "bad_request");
    }
    let (status, _) = add(&h, "a@office.kz", "  ", "correct horse").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = add(&h, "a@office.kz", &"x".repeat(101), "correct horse").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn members_are_listed_and_editable() {
    let h = harness().await;
    let (_, zed) = add(&h, "zed@office.kz", "Zed", "correct horse").await;
    let (_, ana) = add(&h, "ana@office.kz", "Ana", "correct horse").await;
    let zed_id = zed["user"]["id"].as_i64().unwrap();
    let ana_id = ana["user"]["id"].as_i64().unwrap();

    let (status, body) = get_json(&h.app, "/api/v1/users", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    let users = body["users"].as_array().unwrap();
    let names: Vec<&str> = users.iter().map(|u| u["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Ana", "Zed"]);
    assert!(users.iter().all(|u| u["tokenCount"] == 0));

    let (status, body) = send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/users/{zed_id}"),
            Some(&h.token),
            Some(json!({ "name": "Zed Bek" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = get_json(&h.app, &format!("/api/v1/users/{zed_id}"), &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["user"]["name"], "Zed Bek");
    assert_eq!(body["tokens"], json!([]));

    let (status, body) = send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/users/{zed_id}"),
            Some(&h.token),
            Some(json!({ "email": "ANA@office.kz" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "email_taken");

    // Changing your own email's case is not a conflict with yourself.
    let (status, _) = send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/users/{ana_id}"),
            Some(&h.token),
            Some(json!({ "email": "Ana@Office.kz" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = get_json(&h.app, "/api/v1/users/9999", &h.token).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_users_routes_need_a_credential() {
    let h = harness().await;
    let (status, _) = send(&h.app, request("GET", "/api/v1/users", None, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_password_is_stored_hashed() {
    let h = harness().await;
    add(&h, "ana@office.kz", "Ana", "correct horse").await;
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert!(hash.starts_with("$2"), "{hash}");
    assert_ne!(hash, "correct horse");
}

#[tokio::test]
async fn a_starting_password_expires_after_seven_days() {
    let h = harness().await;
    let (_, body) = add(&h, "ana@office.kz", "Ana", "correct horse").await;
    let id = body["user"]["id"].as_i64().unwrap();
    let uri = format!("/api/v1/users/{id}");

    sqlx::query("UPDATE users SET password_set_at = datetime('now', '-8 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (_, body) = get_json(&h.app, &uri, &h.token).await;
    assert_eq!(body["user"]["startingPasswordExpired"], true);

    sqlx::query("UPDATE users SET password_set_at = datetime('now', '-6 days')")
        .execute(&h.pool)
        .await
        .unwrap();
    let (_, body) = get_json(&h.app, &uri, &h.token).await;
    assert_eq!(body["user"]["startingPasswordExpired"], false);
}
