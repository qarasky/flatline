//! Mute contract: the snapshot taken at mute time, coverage in the monitor
//! listing, unmute semantics, and (later tasks) how mutes end and what they
//! silence.

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{Harness, get_json, harness, request, send};
use flatline_backend::heartbeats::{DOWN, UP};
use flatline_backend::monitors::Monitor;

/// Create a monitor of the given type and return its id.
async fn create(h: &Harness, name: &str, kind: &str, extra: Value) -> i64 {
    let mut body = json!({ "name": name, "type": kind });
    if kind == "http" {
        body["url"] = json!(format!("https://{name}.example"));
    }
    if let (Some(map), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    let (status, decoded) = send(
        &h.app,
        request("POST", "/api/v1/monitors", Some(&h.token), Some(body)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create failed: {decoded}");
    decoded["monitor"]["id"].as_i64().unwrap()
}

async fn link(h: &Harness, server: i64, ids: Value) {
    let (status, body) = send(
        &h.app,
        request(
            "PUT",
            &format!("/api/v1/monitors/{server}/links"),
            Some(&h.token),
            Some(json!({ "linkedMonitorIds": ids })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "link failed: {body}");
}

async fn monitor(h: &Harness, id: i64) -> Monitor {
    sqlx::query_as("SELECT * FROM monitors WHERE id = ?")
        .bind(id)
        .fetch_one(&h.pool)
        .await
        .unwrap()
}

/// Record one heartbeat through the engine's shared record path.
async fn beat(h: &Harness, id: i64, status: i64) {
    let monitor = monitor(h, id).await;
    h.state
        .engine
        .record_heartbeat(&monitor, status, None, "test", status == DOWN)
        .await
        .unwrap();
}

async fn mute(h: &Harness, id: i64) -> (StatusCode, Value) {
    send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/monitors/{id}/mute"),
            Some(&h.token),
            None,
        ),
    )
    .await
}

async fn unmute(h: &Harness, id: i64) -> (StatusCode, Value) {
    send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{id}/mute"),
            Some(&h.token),
            None,
        ),
    )
    .await
}

/// The listing's monitor objects by id.
async fn listing(h: &Harness) -> std::collections::HashMap<i64, Value> {
    let (status, body) = get_json(&h.app, "/api/v1/monitors?perPage=200", &h.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["monitors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["id"].as_i64().unwrap(), m.clone()))
        .collect()
}

/// A push server S with websites A and B linked to it.
async fn server_with_sites(h: &Harness) -> (i64, i64, i64) {
    let s = create(h, "s", "push", json!({})).await;
    let a = create(h, "a", "http", json!({})).await;
    let b = create(h, "b", "http", json!({})).await;
    link(h, s, json!([a, b])).await;
    (s, a, b)
}

#[tokio::test]
async fn mute_snapshots_down_host_and_websites() {
    let h = harness().await;
    let (s, a, b) = server_with_sites(&h).await;
    beat(&h, s, DOWN).await;
    beat(&h, a, DOWN).await;
    beat(&h, b, UP).await;

    let (status, body) = mute(&h, s).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mute"]["monitors"], json!([s.min(a), s.max(a)]));
    assert_eq!(body["mute"]["hostMuted"], json!(true));

    let monitors = listing(&h).await;
    assert_eq!(monitors[&s]["mutedBy"], json!([s]));
    assert_eq!(monitors[&a]["mutedBy"], json!([s]));
    assert_eq!(monitors[&b]["mutedBy"], json!([]));
    assert!(monitors[&s]["mute"]["mutedAt"].is_string());
    assert!(monitors[&a]["mute"].is_null());
    assert!(monitors[&b]["mute"].is_null());

    let (status, one) = get_json(&h.app, &format!("/api/v1/monitors/{a}"), &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(one["monitor"]["mutedBy"], json!([s]));
}

#[tokio::test]
async fn mute_refuses_when_nothing_is_down() {
    let h = harness().await;
    let (s, a, b) = server_with_sites(&h).await;
    for id in [s, a, b] {
        beat(&h, id, UP).await;
    }
    let (status, body) = mute(&h, s).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["message"].as_str().unwrap_or_default().contains("nothing to mute"), "{body}");

    let (status, _) = mute(&h, 9999).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = unmute(&h, 9999).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unmute_from_a_covered_website_clears_the_server_mute() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, s, DOWN).await;
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    let (status, body) = unmute(&h, a).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["unmuted"], json!([s]));

    for (_, m) in listing(&h).await {
        assert!(m["mute"].is_null(), "{m}");
        assert_eq!(m["mutedBy"], json!([]), "{m}");
    }
    // Idempotent.
    let (status, body) = unmute(&h, a).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["unmuted"], json!([]));
}

#[tokio::test]
async fn group_with_only_covered_down_children_is_covered() {
    let h = harness().await;
    let g = create(&h, "g", "group", json!({})).await;
    let s = create(&h, "s", "push", json!({})).await;
    let a = create(&h, "a", "http", json!({ "parent": g })).await;
    let c = create(&h, "c", "http", json!({ "parent": g })).await;
    link(&h, s, json!([a])).await;
    beat(&h, s, UP).await;
    beat(&h, a, DOWN).await;
    beat(&h, c, UP).await;
    beat(&h, g, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    assert_eq!(listing(&h).await[&g]["mutedBy"], json!([s]));

    beat(&h, c, DOWN).await;
    assert_eq!(listing(&h).await[&g]["mutedBy"], json!([]));
}

#[tokio::test]
async fn remuting_replaces_the_snapshot() {
    let h = harness().await;
    let (s, a, b) = server_with_sites(&h).await;
    beat(&h, s, DOWN).await;
    beat(&h, a, DOWN).await;
    beat(&h, b, UP).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    // Written straight to the heartbeat table so the snapshot is not
    // touched by the lifecycle hooks of later tasks.
    for (id, status) in [(a, UP), (b, DOWN)] {
        sqlx::query(
            "INSERT INTO heartbeats (monitor_id, time, status, important, retries, down_count, duration)
             VALUES (?, strftime('%Y-%m-%d %H:%M:%f', 'now', '+1 second'), ?, 1, 0, 0, 0)",
        )
        .bind(id)
        .bind(status)
        .execute(&h.pool)
        .await
        .unwrap();
    }

    let (status, body) = mute(&h, s).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mute"]["monitors"], json!([s.min(b), s.max(b)]));
}

#[tokio::test]
async fn openapi_documents_mute() {
    let h = harness().await;
    let (_, body) = get_json(&h.app, "/api/v1/openapi.json", &h.token).await;
    let path = &body["paths"]["/api/v1/monitors/{id}/mute"];
    assert!(path["post"].is_object() && path["delete"].is_object(), "{path}");
    let schema = body["components"]["schemas"]["Monitor"]["properties"].clone();
    assert!(schema["mute"].is_object() && schema["mutedBy"].is_object(), "{schema}");
}
