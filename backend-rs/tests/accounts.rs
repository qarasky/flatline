//! Member accounts: `/api/v1/users` lists and edits the accounts Kore ID
//! provisions. There is no invite-with-password route.

use axum::http::StatusCode;
use serde_json::json;

mod common;
use common::{add_account, get_json, harness, request, send};

#[tokio::test]
async fn members_are_listed_and_editable() {
    let h = harness().await;
    let zed_id = add_account(&h, "zed@office.kz", "Zed").await;
    let ana_id = add_account(&h, "ana@office.kz", "Ana").await;

    let (status, body) = get_json(&h.app, "/api/v1/users", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    let users = body["users"].as_array().unwrap();
    let names: Vec<&str> = users.iter().map(|u| u["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Ana", "Zed"]);
    assert!(users.iter().all(|u| u["tokenCount"] == 0));
    let text = body.to_string();
    assert!(!text.contains("password\""), "{text}");
    assert!(!text.contains("mustChangePassword"), "{text}");
    assert!(!text.contains("startingPasswordExpired"), "{text}");

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
async fn bad_emails_and_names_are_refused() {
    let h = harness().await;
    let id = add_account(&h, "ana@office.kz", "Ana").await;
    for email in ["ana", "@x", "a@", "a@b@c", "  "] {
        let (status, body) = send(
            &h.app,
            request(
                "PATCH",
                &format!("/api/v1/users/{id}"),
                Some(&h.token),
                Some(json!({ "email": email })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{email}: {body}");
        assert_eq!(body["error"], "bad_request");
    }
    for name in ["  ", &"x".repeat(101)] {
        let (status, _) = send(
            &h.app,
            request(
                "PATCH",
                &format!("/api/v1/users/{id}"),
                Some(&h.token),
                Some(json!({ "name": name })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn there_is_no_invite_with_password_route() {
    let h = harness().await;
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/users",
            Some(&h.token),
            Some(json!({ "email": "ana@office.kz", "name": "Ana", "password": "correct horse" })),
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::METHOD_NOT_ALLOWED,
        "accounts come from Kore ID"
    );

    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/users/1/reset-password",
            Some(&h.token),
            Some(json!({ "password": "another password" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_users_routes_need_a_credential() {
    let h = harness().await;
    let (status, _) = send(&h.app, request("GET", "/api/v1/users", None, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
