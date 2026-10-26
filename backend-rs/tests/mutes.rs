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

async fn current(h: &Harness, subject: i64) -> Option<flatline_backend::mutes::Mute> {
    flatline_backend::mutes::get(&h.pool, subject).await.unwrap()
}

async fn push_token(h: &Harness, id: i64) -> String {
    sqlx::query_scalar("SELECT push_token FROM monitors WHERE id = ?")
        .bind(id)
        .fetch_one(&h.pool)
        .await
        .unwrap()
}

/// A push with a metrics sample (records an UP beat too).
async fn push_sample(h: &Harness, id: i64, metrics: Value) {
    let token = push_token(h, id).await;
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/push/{token}"),
            None,
            Some(json!({ "metrics": metrics })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

fn disks(root: f64, sdb: &str) -> Value {
    json!({
        "disk": [{ "mount": "/", "percent": root }],
        "smart": { "available": true, "disks": [
            { "device": "/dev/sda", "health": "passed" },
            { "device": "/dev/sdb", "health": sdb }
        ]}
    })
}

#[tokio::test]
async fn new_website_down_ends_mute() {
    let h = harness().await;
    let (s, a, b) = server_with_sites(&h).await;
    beat(&h, s, DOWN).await;
    beat(&h, a, DOWN).await;
    beat(&h, b, UP).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    let mut events = h.state.events.subscribe();
    beat(&h, b, DOWN).await;
    assert!(current(&h, s).await.is_none(), "a new down website ends the mute");
    let mut saw_invalidate = false;
    while let Ok(event) = events.try_recv() {
        saw_invalidate |= event.kind() == "invalidate";
    }
    assert!(saw_invalidate, "the end of a mute is published");
}

#[tokio::test]
async fn new_group_child_down_ends_mute() {
    let h = harness().await;
    let g = create(&h, "g", "group", json!({})).await;
    let s = create(&h, "s", "push", json!({})).await;
    let a = create(&h, "a", "http", json!({ "parent": g })).await;
    link(&h, s, json!([g])).await;
    beat(&h, s, UP).await;
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    let d = create(&h, "d", "http", json!({ "parent": g })).await;
    beat(&h, d, DOWN).await;
    assert!(current(&h, s).await.is_none());
}

#[tokio::test]
async fn recovery_shrinks_then_ends_mute() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, s, DOWN).await;
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    beat(&h, a, UP).await;
    assert_eq!(current(&h, s).await.unwrap().monitors, vec![s]);
    beat(&h, a, DOWN).await;
    assert!(current(&h, s).await.is_none(), "down again after recovery is new");

    // Second scenario: everything recovers.
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    beat(&h, s, UP).await;
    assert_eq!(current(&h, s).await.unwrap().monitors, vec![a]);
    beat(&h, a, UP).await;
    assert!(current(&h, s).await.is_none(), "full recovery ends the mute");
}

#[tokio::test]
async fn pending_does_not_end_mute() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, s, UP).await;
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    flatline_backend::mutes::on_status(&h.pool, a, flatline_backend::heartbeats::PENDING)
        .await
        .unwrap();
    assert_eq!(current(&h, s).await.unwrap().monitors, vec![a]);
}

#[tokio::test]
async fn new_failing_disk_ends_mute() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, a, DOWN).await;
    push_sample(&h, s, disks(40.0, "passed")).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    push_sample(&h, s, disks(40.0, "passed")).await;
    assert!(current(&h, s).await.is_some());
    push_sample(&h, s, disks(40.0, "failed")).await;
    assert!(current(&h, s).await.is_none(), "a newly failing disk ends the mute");
}

#[tokio::test]
async fn disk_already_full_at_mute_time_does_not_end_mute() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, a, DOWN).await;
    push_sample(&h, s, disks(95.0, "passed")).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    assert_eq!(current(&h, s).await.unwrap().full_mounts, vec!["/".to_string()]);

    push_sample(&h, s, disks(96.0, "passed")).await;
    assert!(current(&h, s).await.is_some(), "still the same breach");
    push_sample(&h, s, disks(50.0, "passed")).await;
    assert!(current(&h, s).await.unwrap().full_mounts.is_empty());
    push_sample(&h, s, disks(95.0, "passed")).await;
    assert!(current(&h, s).await.is_none(), "a new breach ends the mute");
}

#[tokio::test]
async fn deleting_a_snapshot_monitor_shrinks_the_mute() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, s, UP).await;
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    let (status, _) = send(
        &h.app,
        request("DELETE", &format!("/api/v1/monitors/{a}"), Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(current(&h, s).await.is_none());
}

// -- Telegram ----------------------------------------------------------------

use axum::routing::post;
use axum::{Json, Router};
use std::sync::{Arc, Mutex};
use std::time::Duration;

async fn alert_stub() -> (String, Arc<Mutex<Vec<Value>>>) {
    let captured: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let stub = {
        let captured = Arc::clone(&captured);
        Router::new().route(
            "/bot{token}/sendMessage",
            post(move |Json(body): Json<Value>| {
                let captured = Arc::clone(&captured);
                async move {
                    captured.lock().unwrap().push(body);
                    Json(json!({ "ok": true, "result": true }))
                }
            }),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, stub).await.unwrap();
    });
    (format!("http://{addr}"), captured)
}

async fn alert_notification(h: &Harness, base_url: &str) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO notifications (name, type, config) VALUES ('alerts', 'telegram', ?) RETURNING id",
    )
    .bind(
        json!({
            "telegramServerUrl": base_url,
            "telegramBotToken": "TEST:TOKEN",
            "telegramChatID": "-100123",
        })
        .to_string(),
    )
    .fetch_one(&h.pool)
    .await
    .unwrap()
}

/// Sent texts containing `needle`, after letting the queues drain.
async fn sent(captured: &Arc<Mutex<Vec<Value>>>, needle: &str) -> usize {
    tokio::time::sleep(Duration::from_millis(200)).await;
    captured
        .lock()
        .unwrap()
        .iter()
        .filter_map(|body| body["text"].as_str())
        .filter(|text| text.contains(needle))
        .count()
}

#[tokio::test]
async fn muted_monitor_resends_are_silent() {
    let h = harness().await;
    let (url, captured) = alert_stub().await;
    let n = alert_notification(&h, &url).await;
    let s = create(&h, "srv", "push", json!({ "notificationIDList": [n] })).await;
    let a = create(&h, "site-a", "http", json!({ "resendInterval": 1, "notificationIDList": [n] })).await;
    let b = create(&h, "site-b", "http", json!({ "notificationIDList": [n] })).await;
    link(&h, s, json!([a, b])).await;
    beat(&h, s, UP).await;
    beat(&h, b, UP).await;
    beat(&h, a, DOWN).await;
    assert_eq!(sent(&captured, "[site-a]").await, 1, "the outage pages once");

    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    beat(&h, a, DOWN).await;
    beat(&h, a, DOWN).await;
    assert_eq!(sent(&captured, "[site-a]").await, 1, "resends are silent while muted");

    assert_eq!(unmute(&h, s).await.0, StatusCode::OK);
    beat(&h, a, DOWN).await;
    assert_eq!(sent(&captured, "[site-a]").await, 2, "unmuted resends resume");

    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    beat(&h, b, DOWN).await;
    assert_eq!(sent(&captured, "[site-b]").await, 1, "a new outage pages while muted");
}

#[tokio::test]
async fn recovery_is_sent_while_muted() {
    let h = harness().await;
    let (url, captured) = alert_stub().await;
    let n = alert_notification(&h, &url).await;
    let s = create(&h, "srv", "push", json!({})).await;
    let a = create(&h, "site-a", "http", json!({ "notificationIDList": [n] })).await;
    link(&h, s, json!([a])).await;
    beat(&h, s, UP).await;
    beat(&h, a, DOWN).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    beat(&h, a, UP).await;
    assert_eq!(sent(&captured, "UP").await, 1, "{:?}", captured.lock().unwrap());
}

#[tokio::test]
async fn covered_group_is_silent() {
    let h = harness().await;
    let (url, captured) = alert_stub().await;
    let n = alert_notification(&h, &url).await;
    let g = create(&h, "grp", "group", json!({ "resendInterval": 1, "notificationIDList": [n] })).await;
    let s = create(&h, "srv", "push", json!({})).await;
    let a = create(&h, "site-a", "http", json!({ "parent": g })).await;
    link(&h, s, json!([a])).await;
    beat(&h, s, UP).await;
    beat(&h, a, DOWN).await;
    beat(&h, g, DOWN).await;
    assert_eq!(sent(&captured, "[grp]").await, 1);

    assert_eq!(mute(&h, s).await.0, StatusCode::OK);
    beat(&h, g, DOWN).await;
    beat(&h, g, DOWN).await;
    assert_eq!(sent(&captured, "[grp]").await, 1, "a covered group's resends are silent");
}

#[tokio::test]
async fn host_muted_silences_cpu_ram_not_disk() {
    let h = harness().await;
    let (url, captured) = alert_stub().await;
    let n = alert_notification(&h, &url).await;
    let s = create(
        &h,
        "srv",
        "push",
        json!({ "metricCpuThreshold": 50, "metricDiskThreshold": 80, "notificationIDList": [n] }),
    )
    .await;
    // Artificial on purpose: the host is "muted" while it pushes, which
    // isolates the alert path from the mute lifecycle.
    sqlx::query("INSERT INTO monitor_mutes (monitor_id, muted_at, monitors) VALUES (?, '2026-10-26 00:00:00.000', ?)")
        .bind(s)
        .bind(json!([s]).to_string())
        .execute(&h.pool)
        .await
        .unwrap();
    let monitor = monitor(&h, s).await;
    let sample = json!({
        "cpu": { "percent": 95.0 },
        "disk": [{ "mount": "/", "percent": 85.0 }]
    });
    let now = chrono::Utc::now().timestamp_millis();
    for offset in [0, 61_000] {
        let time = flatline_backend::metrics::sql_time_millis(now + offset);
        h.state.metrics.store(s, &time, &sample, true).await.unwrap();
        h.state.metrics.evaluate_alerts_at(&monitor, now + offset).await;
    }
    assert_eq!(sent(&captured, "[cpu]").await, 0, "CPU is silenced while the host is muted");
    assert_eq!(sent(&captured, "[disk]").await, 1, "a disk breach always pages");
}

#[tokio::test]
async fn host_recovery_resumes_backup_alerts() {
    use flatline_backend::backups::NewAgent;
    let h = harness().await;
    let (url, captured) = alert_stub().await;
    let n = alert_notification(&h, &url).await;
    let t0 = chrono::Utc::now() - chrono::Duration::days(3);

    // Host muted: its backups are expected to fall behind.
    let down_host = create(&h, "down-host", "push", json!({ "notificationIDList": [n] })).await;
    beat(&h, down_host, DOWN).await;
    assert_eq!(mute(&h, down_host).await.0, StatusCode::OK);

    // Only a website muted: the running server's backups still matter.
    let up_host = create(&h, "up-host", "push", json!({ "notificationIDList": [n] })).await;
    let site = create(&h, "site", "http", json!({})).await;
    link(&h, up_host, json!([site])).await;
    beat(&h, up_host, UP).await;
    beat(&h, site, DOWN).await;
    assert_eq!(mute(&h, up_host).await.0, StatusCode::OK);

    for (name, monitor_id) in [("backup-down", down_host), ("backup-up", up_host)] {
        h.state
            .backups
            .register_agent_at(
                NewAgent {
                    name: name.to_string(),
                    monitor_id: Some(monitor_id),
                    enabled: true,
                    interval_seconds: 86400,
                    retention_count: 7,
                },
                t0,
            )
            .await
            .unwrap();
    }
    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::hours(37)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(sent(&captured, "backup-down").await, 0, "muted host: overdue is silent");
    assert_eq!(sent(&captured, "backup-up").await, 1, "website-only mute: overdue pages");
}

// -- Final review fixes ------------------------------------------------------

#[tokio::test]
async fn concurrent_recoveries_both_leave_the_snapshot() {
    let h = harness().await;
    let s = create(&h, "s", "push", json!({})).await;
    let mut sites = Vec::new();
    for i in 0..6 {
        sites.push(create(&h, &format!("w{i}"), "http", json!({})).await);
    }
    link(&h, s, json!(sites)).await;
    beat(&h, s, DOWN).await;
    for id in &sites {
        beat(&h, *id, DOWN).await;
    }
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    let pool = h.pool.clone();
    let tasks: Vec<_> = sites
        .iter()
        .map(|id| {
            let pool = pool.clone();
            let id = *id;
            tokio::spawn(async move {
                flatline_backend::mutes::on_status(&pool, id, UP).await.unwrap()
            })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(current(&h, s).await.unwrap().monitors, vec![s], "every recovery is kept");
}

#[tokio::test]
async fn a_sample_without_disks_keeps_the_full_mounts() {
    let h = harness().await;
    let (s, a, _b) = server_with_sites(&h).await;
    beat(&h, a, DOWN).await;
    push_sample(&h, s, disks(95.0, "passed")).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    // An agent that just restarted reports no disks yet.
    push_sample(&h, s, json!({ "cpu": { "percent": 5.0 }, "disk": null })).await;
    assert_eq!(current(&h, s).await.unwrap().full_mounts, vec!["/".to_string()]);
    push_sample(&h, s, disks(95.0, "passed")).await;
    assert!(current(&h, s).await.is_some(), "the same breach is not new");
}

#[tokio::test]
async fn a_mute_ended_by_a_disk_is_announced() {
    let h = harness().await;
    let (url, captured) = alert_stub().await;
    let n = alert_notification(&h, &url).await;
    let s = create(&h, "srv", "push", json!({ "notificationIDList": [n] })).await;
    let a = create(&h, "site-a", "http", json!({})).await;
    link(&h, s, json!([a])).await;
    beat(&h, a, DOWN).await;
    push_sample(&h, s, disks(40.0, "passed")).await;
    assert_eq!(mute(&h, s).await.0, StatusCode::OK);

    push_sample(&h, s, disks(40.0, "failed")).await;
    assert_eq!(sent(&captured, "/dev/sdb").await, 1, "{:?}", captured.lock().unwrap());
}

#[tokio::test]
async fn muting_a_group_mutes_its_down_monitors() {
    let h = harness().await;
    let g = create(&h, "g", "group", json!({})).await;
    let a = create(&h, "a", "http", json!({ "parent": g })).await;
    let b = create(&h, "b", "http", json!({ "parent": g })).await;
    beat(&h, a, DOWN).await;
    beat(&h, b, UP).await;
    beat(&h, g, DOWN).await;

    let (status, body) = mute(&h, g).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mute"]["monitors"], json!([g.min(a), g.max(a)]));
    assert_eq!(listing(&h).await[&a]["mutedBy"], json!([g]));

    beat(&h, b, DOWN).await;
    assert!(current(&h, g).await.is_none(), "a new down monitor in the group ends its mute");
}
