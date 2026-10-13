//! Monitor CRUD contract: shapes, validation, groups and the auth compat
//! endpoints the reused SPA calls.

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{Harness, get_json, harness, request, send};

/// POST a monitor and return (status, body).
async fn create(h: &Harness, body: Value) -> (StatusCode, Value) {
    send(
        &h.app,
        request("POST", "/api/v1/monitors", Some(&h.token), Some(body)),
    )
    .await
}

/// PATCH a monitor and return (status, body).
async fn patch(h: &Harness, id: i64, body: Value) -> (StatusCode, Value) {
    send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/monitors/{id}"),
            Some(&h.token),
            Some(body),
        ),
    )
    .await
}

async fn create_push(h: &Harness, name: &str) -> Value {
    let (status, body) = create(h, json!({ "name": name, "type": "push" })).await;
    assert_eq!(status, StatusCode::CREATED, "create failed: {body}");
    body["monitor"].clone()
}

#[tokio::test]
async fn create_push_monitor_mints_a_push_token() {
    let h = harness().await;
    let (status, body) = create(&h, json!({ "name": "agent-host", "type": "push" })).await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["ok"], true);
    assert_eq!(body["monitor"]["type"], "push");
    assert_eq!(body["monitor"]["status"], 2, "no heartbeat yet = pending");
    assert_eq!(body["monitor"]["interval"], 20, "Node default");
    assert!(
        body["monitor"]["pushToken"].is_string(),
        "push monitors get a token"
    );
    assert_eq!(body["ignoredFields"], json!([]));
}

#[tokio::test]
async fn create_validates_type_and_required_fields() {
    let h = harness().await;

    let (status, body) = create(&h, json!({ "type": "push" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "bad_request");

    let (status, body) = create(&h, json!({ "name": "x", "type": "mqtt" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("Unknown monitor type")
    );

    let (status, body) = create(&h, json!({ "name": "x", "type": "http" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["message"].as_str().unwrap().contains("url"));
}

#[tokio::test]
async fn create_reports_ignored_fields() {
    let h = harness().await;
    let (status, body) = create(
        &h,
        json!({
            "name": "web", "type": "http", "url": "https://example.com",
            "keyword": "healthy", "tags": [ 1 ], "notificationIDList": { "1": true }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    let ignored = body["ignoredFields"].as_array().unwrap();
    assert!(ignored.contains(&json!("keyword")));
    assert!(ignored.contains(&json!("tags")));
    // notificationIDList is accepted silently, like Node.
    assert!(!ignored.contains(&json!("notificationIDList")));
}

#[tokio::test]
async fn list_paginates_and_filters() {
    let h = harness().await;
    create_push(&h, "alpha").await;
    create_push(&h, "beta").await;
    create_push(&h, "gamma").await;
    let paused = create_push(&h, "delta").await;
    patch(
        &h,
        paused["id"].as_i64().unwrap(),
        json!({ "active": false }),
    )
    .await;

    let (status, body) = get_json(&h.app, "/api/v1/monitors?page=1&perPage=2", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 2);
    assert_eq!(body["pagination"]["total"], 4);
    assert_eq!(body["pagination"]["perPage"], 2);
    assert_eq!(body["pagination"]["totalPages"], 2);
    assert_eq!(body["pagination"]["hasMore"], true);

    let (_, body) = get_json(&h.app, "/api/v1/monitors?page=2&perPage=2", &h.token).await;
    assert_eq!(body["pagination"]["hasMore"], false);

    let (_, body) = get_json(&h.app, "/api/v1/monitors?active=true", &h.token).await;
    assert_eq!(body["pagination"]["total"], 3);

    let (_, body) = get_json(&h.app, "/api/v1/monitors?q=beta", &h.token).await;
    assert_eq!(body["count"], 1);
    assert_eq!(body["monitors"][0]["name"], "beta");

    // Pagination validation parity.
    let (status, _) = get_json(&h.app, "/api/v1/monitors?page=0", &h.token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = get_json(&h.app, "/api/v1/monitors?perPage=nope", &h.token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_is_partial_and_validates() {
    let h = harness().await;
    let monitor = create_push(&h, "patch-me").await;
    let id = monitor["id"].as_i64().unwrap();

    // Partial: only the name changes.
    let (status, body) = patch(&h, id, json!({ "name": "renamed" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["monitor"]["name"], "renamed");
    assert_eq!(body["monitor"]["interval"], 20, "untouched field survives");
    assert_eq!(
        body["monitor"]["pushToken"], monitor["pushToken"],
        "token survives"
    );

    // Type is immutable.
    let (status, body) = patch(&h, id, json!({ "type": "http" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("cannot be changed")
    );

    // Bad interval is a 400, not a silent clamp.
    let (status, _) = patch(&h, id, json!({ "interval": 5 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Thresholds: 1-100 stored, anything else disables.
    let (status, body) = patch(&h, id, json!({ "metricCpuThreshold": 90 })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["monitor"]["metricCpuThreshold"], 90);
    let (_, body) = patch(&h, id, json!({ "metricCpuThreshold": 0 })).await;
    assert_eq!(body["monitor"]["metricCpuThreshold"], Value::Null);
}

#[tokio::test]
async fn groups_link_children_and_reject_cycles() {
    let h = harness().await;

    let (status, group) = create(&h, json!({ "name": "clients", "type": "group" })).await;
    assert_eq!(status, StatusCode::CREATED);
    let group_id = group["monitor"]["id"].as_i64().unwrap();

    // Child lands in the group.
    let (status, child) = create(
        &h,
        json!({ "name": "client-a", "type": "push", "parent": group_id }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(child["monitor"]["parent"], group_id);
    let child_id = child["monitor"]["id"].as_i64().unwrap();

    // Self-parent and descendant cycles are rejected.
    let (status, body) = patch(&h, group_id, json!({ "parent": group_id })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["message"], "Invalid Monitor Group");
    let (status, _) = patch(&h, group_id, json!({ "parent": child_id })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A non-group parent is rejected.
    let (status, _) = create(
        &h,
        json!({ "name": "x", "type": "push", "parent": child_id }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Unlink works.
    let (status, body) = patch(&h, child_id, json!({ "parent": null })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["monitor"]["parent"], Value::Null);
}

#[tokio::test]
async fn delete_unlinks_or_removes_children() {
    let h = harness().await;

    let (_, group) = create(&h, json!({ "name": "g1", "type": "group" })).await;
    let group_id = group["monitor"]["id"].as_i64().unwrap();
    let (_, child) = create(
        &h,
        json!({ "name": "c1", "type": "push", "parent": group_id }),
    )
    .await;
    let child_id = child["monitor"]["id"].as_i64().unwrap();

    // Plain delete unlinks the child.
    let (status, body) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{group_id}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 1);
    let (_, child_now) = get_json(&h.app, &format!("/api/v1/monitors/{child_id}"), &h.token).await;
    assert_eq!(
        child_now["monitor"]["parent"],
        Value::Null,
        "orphan survives, unlinked"
    );

    // deleteChildren removes the subtree.
    let (_, group) = create(&h, json!({ "name": "g2", "type": "group" })).await;
    let group_id = group["monitor"]["id"].as_i64().unwrap();
    let (_, child) = create(
        &h,
        json!({ "name": "c2", "type": "push", "parent": group_id }),
    )
    .await;
    let child_id = child["monitor"]["id"].as_i64().unwrap();
    let (status, body) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{group_id}?deleteChildren=true"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 2);
    let deleted: Vec<i64> = body["deleted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    assert!(deleted.contains(&group_id) && deleted.contains(&child_id));
}

#[tokio::test]
async fn monitor_types_lists_the_supported_surface() {
    let h = harness().await;
    let (status, body) = get_json(&h.app, "/api/v1/monitor-types", &h.token).await;

    assert_eq!(status, StatusCode::OK);
    for kind in ["http", "https", "push", "group"] {
        assert!(body["types"][kind].is_object(), "{kind} must be listed");
    }
    assert!(body["writableFields"].as_array().unwrap().len() > 10);
}

#[tokio::test]
async fn auth_compat_accepts_the_token_as_password() {
    let h = harness().await;

    let (status, body) = send(&h.app, request("GET", "/api/v1/auth/setup", None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["setupNeeded"], false);

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "username": "operator", "password": h.token })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["token"], h.token);
    assert_eq!(body["user"]["name"], "Operator");

    let (status, _) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "username": "operator", "password": "wrong" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = get_json(&h.app, "/api/v1/auth/me", &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["user"]["name"], "Operator");
    assert_eq!(body["scopes"], json!(["read", "write"]));
}

#[tokio::test]
async fn push_failures_clear_acknowledges_and_resets_on_restart() {
    let h = harness().await;
    let monitor = create_push(&h, "cmn").await;
    let id = monitor["id"].as_i64().unwrap();
    let push_token = monitor["pushToken"].as_str().unwrap().to_string();
    assert_eq!(monitor["pushFailuresAck"], 0);

    // No samples yet: clearing acknowledges zero rather than failing.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/monitors/{id}/push-failures/clear"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "clear failed: {body}");
    assert_eq!(body["pushFailuresAck"], 0);
    assert_eq!(body["reported"], Value::Null);

    // A sample reports three failures; the monitor JSON carries the ack.
    let sample = |failed: u64| {
        json!({
            "metrics": {
                "host": { "hostname": "cmn" },
                "cpu": { "percent": 5.0, "cores": 2 },
                "mem": { "percent": 20.0, "total": 100, "used": 20 },
                "agent": { "version": "1.5.0", "uptime": 60, "failedPushes": failed },
            }
        })
    };
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/push/{push_token}"),
            None,
            Some(sample(3)),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/monitors/{id}/push-failures/clear"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pushFailuresAck"], 3);
    assert_eq!(body["reported"], 3);

    let (status, body) = get_json(&h.app, &format!("/api/v1/monitors/{id}"), &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["monitor"]["pushFailuresAck"], 3);

    // The agent restarts: its counter moves backwards, so the stale ack is
    // dropped instead of hiding the next failures.
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/push/{push_token}"),
            None,
            Some(sample(1)),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = get_json(&h.app, &format!("/api/v1/monitors/{id}"), &h.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["monitor"]["pushFailuresAck"], 0);
}
