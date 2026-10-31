//! Notification configs: which monitors use each, and the bot token an edit
//! must not lose (the list never returns it).

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{Harness, get_json, harness, request, send};

async fn create_notification(h: &Harness, name: &str, token: &str) -> i64 {
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/notifications",
            Some(&h.token),
            Some(json!({
                "name": name,
                "type": "telegram",
                "config": { "telegramBotToken": token, "telegramChatID": "-100" }
            })),
        ),
    )
    .await;
    assert!(status.is_success(), "{body}");
    body["id"].as_i64().unwrap()
}

async fn create_monitor(h: &Harness, name: &str, notifications: &[i64]) -> i64 {
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": name, "type": "http", "url": "https://example.com", "notificationIDList": notifications })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["monitor"]["id"].as_i64().unwrap()
}

async fn stored_config(h: &Harness, id: i64) -> Value {
    let raw: String = sqlx::query_scalar("SELECT config FROM notifications WHERE id = ?")
        .bind(id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

async fn listed(h: &Harness, id: i64) -> Value {
    let (status, body) = get_json(&h.app, "/api/v1/notifications", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    body["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == id)
        .cloned()
        .unwrap()
}

fn patch(h: &Harness, id: i64, body: Value) -> axum::http::Request<axum::body::Body> {
    request("PATCH", &format!("/api/v1/notifications/{id}"), Some(&h.token), Some(body))
}

#[tokio::test]
async fn the_list_names_the_monitors_using_each_notification() {
    let h = harness().await;
    let ops = create_notification(&h, "ops", "123:abc").await;
    let quiet = create_notification(&h, "quiet", "456:def").await;
    let b = create_monitor(&h, "b", &[ops]).await;
    let a = create_monitor(&h, "a", &[ops]).await;
    assert_eq!(listed(&h, ops).await["monitorIds"], json!([b.min(a), b.max(a)]));
    assert_eq!(listed(&h, quiet).await["monitorIds"], json!([]));
    assert!(listed(&h, ops).await["config"].get("telegramBotToken").is_none());
}

#[tokio::test]
async fn patching_without_the_bot_token_keeps_it() {
    let h = harness().await;
    let id = create_notification(&h, "ops", "123:abc").await;
    for config in [
        json!({ "telegramChatID": "-200" }),
        json!({ "telegramChatID": "-300", "telegramBotToken": "" }),
    ] {
        let (status, body) = send(&h.app, patch(&h, id, json!({ "name": "ops 2", "config": config }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let stored = stored_config(&h, id).await;
        assert_eq!(stored["telegramBotToken"], "123:abc");
        assert_eq!(stored["telegramChatID"], config["telegramChatID"]);
    }
}

#[tokio::test]
async fn patching_with_a_new_bot_token_replaces_it() {
    let h = harness().await;
    let id = create_notification(&h, "ops", "123:abc").await;
    let (status, _) = send(
        &h.app,
        patch(&h, id, json!({ "config": { "telegramBotToken": "999:zzz", "telegramChatID": "-100" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored_config(&h, id).await["telegramBotToken"], "999:zzz");
}

#[tokio::test]
async fn deleting_a_notification_unlinks_its_monitors() {
    let h = harness().await;
    let id = create_notification(&h, "ops", "123:abc").await;
    let monitor = create_monitor(&h, "a", &[id]).await;
    let (status, _) = send(
        &h.app,
        request("DELETE", &format!("/api/v1/notifications/{id}"), Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = get_json(&h.app, &format!("/api/v1/monitors/{monitor}"), &h.token).await;
    assert_eq!(body["monitor"]["notificationIds"], json!([]));
}
