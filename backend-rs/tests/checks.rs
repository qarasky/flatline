//! M2 integration tests: the push contract, heartbeat history, the HTTP
//! check loop, the push-timeout watcher, and Telegram dispatch.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::Json;
use axum::routing::{get, post};
use common::{get_json, harness, request, send};
use flatline_backend::heartbeats::{self, Beat, DOWN, PENDING, UP};
use serde_json::{Value, json};
use sqlx::SqlitePool;

/// Serve a router on an ephemeral port; returns its base URL.
async fn spawn_server(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

/// A URL nothing listens on (bind, note the port, drop the listener).
async fn closed_port_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{addr}")
}

async fn heartbeat_count(pool: &SqlitePool, id: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Create a monitor through the API and return `(id, pushToken)`.
async fn create_monitor(h: &common::Harness, body: Value) -> (i64, Option<String>) {
    let (status, response) = send(
        &h.app,
        request("POST", "/api/v1/monitors", Some(&h.token), Some(body)),
    )
    .await;
    assert_eq!(status, 201, "create failed: {response}");
    (
        response["monitor"]["id"].as_i64().unwrap(),
        response["monitor"]["pushToken"]
            .as_str()
            .map(str::to_string),
    )
}

#[tokio::test]
async fn push_endpoint_lifecycle_and_fast_path() {
    let h = harness().await;
    let (id, push_token) = create_monitor(
        &h,
        json!({ "name": "cmn", "type": "push", "interval": 180, "maxretries": 2 }),
    )
    .await;
    let push_token = push_token.expect("push monitors get a token");

    // 1. A legacy GET push records an UP heartbeat.
    let (status, body) = send(
        &h.app,
        request("GET", &format!("/api/push/{push_token}"), None, None),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(heartbeat_count(&h.pool, id).await, 1);

    let beat = heartbeats::latest(&h.pool, id).await.unwrap().unwrap();
    assert_eq!(beat.status, UP);
    assert_eq!(beat.important, 1, "the first beat is important");
    assert_eq!(beat.msg.as_deref(), Some("OK"));

    // 2. Telemetry fast path: previous beat UP and fresh — accepted without
    //    writing a heartbeat row.
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/push/{push_token}?telemetry=1"),
            None,
            Some(json!({ "metrics": { "cpu": 1.5 } })),
        ),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        heartbeat_count(&h.pool, id).await,
        1,
        "the telemetry fast path must not create a heartbeat row"
    );

    // 3. A legacy push always records, even moments later.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/api/push/{push_token}?msg=legacy"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(heartbeat_count(&h.pool, id).await, 2);

    // 4. An explicit status=down bypasses the retry walk.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/api/push/{push_token}?status=down&msg=crash"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, 200);
    let beat = heartbeats::latest(&h.pool, id).await.unwrap().unwrap();
    assert_eq!(beat.status, DOWN, "explicit down must be immediate");
    assert_eq!(beat.msg.as_deref(), Some("crash"));

    // 5. Unknown token: 404 with the Node envelope.
    let (status, body) = send(&h.app, request("GET", "/api/push/nope", None, None)).await;
    assert_eq!(status, 404);
    assert_eq!(body["ok"], false);
    assert!(body["msg"].is_string());

    // 6. Out-of-range ping: 404 like the Node handler.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/api/push/{push_token}?ping=-1"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn heartbeats_endpoint_shape_and_limits() {
    let h = harness().await;
    let (id, push_token) = create_monitor(&h, json!({ "name": "hist", "type": "push" })).await;
    let push_token = push_token.unwrap();

    for msg in ["one", "two", "three"] {
        let (status, _) = send(
            &h.app,
            request(
                "GET",
                &format!("/api/push/{push_token}?msg={msg}"),
                None,
                None,
            ),
        )
        .await;
        assert_eq!(status, 200);
    }

    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/heartbeats?limit=2"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(body["monitorId"], id);
    assert_eq!(body["count"], 2);
    assert_eq!(body["total"], 3);
    assert_eq!(body["limit"], 2);
    // Newest first.
    assert_eq!(body["heartbeats"][0]["msg"], "three");
    assert!(body["heartbeats"][0]["time"].is_string());
    assert!(body["heartbeats"][0]["important"].is_boolean());

    // Non-numeric limit is a 400, like Node.
    let (status, _) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/heartbeats?limit=abc"),
        &h.token,
    )
    .await;
    assert_eq!(status, 400);

    // Unknown monitor is a 404.
    let (status, _) = get_json(&h.app, "/api/v1/monitors/9999/heartbeats", &h.token).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn http_engine_records_up_and_down() {
    let h = harness().await;

    let ok_url = spawn_server(Router::new().route("/", get(|| async { "ok" }))).await;
    let (up_id, _) = create_monitor(
        &h,
        json!({ "name": "site", "type": "http", "url": ok_url, "interval": 20, "timeout": 5 }),
    )
    .await;

    let dead_url = closed_port_url().await;
    let (down_id, _) = create_monitor(
        &h,
        json!({ "name": "dead", "type": "http", "url": dead_url, "interval": 20, "timeout": 5 }),
    )
    .await;

    h.state.engine.start_all().await;

    // The UP monitor answers 200; the first check runs immediately.
    let mut up_seen = false;
    for _ in 0..100 {
        if let Some(beat) = heartbeats::latest(&h.pool, up_id).await.unwrap()
            && beat.status == UP
        {
            assert!(beat.msg.unwrap_or_default().starts_with("200"));
            assert!(beat.ping.unwrap_or(-1.0) >= 0.0);
            up_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(up_seen, "the http check must record an UP heartbeat");

    // The dead monitor refuses the connection; with maxretries 0 it is DOWN
    // immediately.
    let mut down_seen = false;
    for _ in 0..100 {
        if let Some(beat) = heartbeats::latest(&h.pool, down_id).await.unwrap()
            && beat.status == DOWN
        {
            assert!(!beat.msg.unwrap_or_default().is_empty());
            down_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(down_seen, "the http check must record a DOWN heartbeat");

    h.state.engine.stop(up_id);
    h.state.engine.stop(down_id);
}

#[tokio::test]
async fn push_watcher_pends_then_downs_after_the_window() {
    let h = harness().await;
    let (id, _) = create_monitor(
        &h,
        json!({
            "name": "quiet-host", "type": "push",
            "interval": 20, "maxretries": 1, "retryInterval": 1
        }),
    )
    .await;

    // A stale UP beat: its window passed long ago.
    let stale = (chrono::Utc::now() - chrono::Duration::seconds(120))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, 1)")
        .bind(id)
        .bind(&stale)
        .execute(&h.pool)
        .await
        .unwrap();

    h.state.engine.start_all().await;

    // The watcher records PENDING (retry 1 of 1), then DOWN a retry later.
    let mut down = false;
    for _ in 0..150 {
        let beat: Option<Beat> = heartbeats::latest(&h.pool, id).await.unwrap();
        if let Some(beat) = beat
            && beat.status == DOWN
        {
            assert_eq!(beat.msg.as_deref(), Some("No heartbeat in the time window"));
            down = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(down, "the watcher must declare the monitor down");

    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ? AND status = ?")
            .bind(id)
            .bind(PENDING)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(pending, 1, "the retry walk must pass through PENDING");

    h.state.engine.stop(id);
}

#[tokio::test]
async fn ping_engine_checks_icmp_when_available() {
    // The checker shells out to the system `ping`; CI images without it
    // skip rather than fail.
    let available = std::process::Command::new("ping")
        .arg("-V")
        .output()
        .map(|output| output.status.success() || !output.stdout.is_empty())
        .unwrap_or(false);
    if !available {
        eprintln!("skipping: no `ping` binary on PATH");
        return;
    }

    let h = harness().await;
    let (up_id, _) = create_monitor(
        &h,
        json!({
            "name": "localhost", "type": "ping", "hostname": "127.0.0.1",
            "interval": 20, "timeout": 5, "pingCount": 1, "pingPerRequestTimeout": 2
        }),
    )
    .await;

    // A .invalid hostname never resolves: the failure path with the raw
    // ping output as the message, like the Node wrapper.
    let (down_id, _) = create_monitor(
        &h,
        json!({
            "name": "nowhere", "type": "ping", "hostname": "definitely-not-a-host.invalid",
            "interval": 20, "timeout": 5, "pingCount": 1, "pingPerRequestTimeout": 2
        }),
    )
    .await;

    h.state.engine.start_all().await;

    let mut up_seen = false;
    for _ in 0..100 {
        if let Some(beat) = heartbeats::latest(&h.pool, up_id).await.unwrap()
            && beat.status == UP
        {
            assert_eq!(beat.msg.as_deref(), Some(""));
            assert!(beat.ping.unwrap_or(-1.0) >= 0.0);
            up_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(up_seen, "the ping check must record an UP heartbeat");

    let mut down_seen = false;
    for _ in 0..200 {
        if let Some(beat) = heartbeats::latest(&h.pool, down_id).await.unwrap()
            && beat.status == DOWN
        {
            let message = beat.msg.unwrap_or_default();
            assert!(!message.is_empty(), "the failure reports ping's output");
            down_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        down_seen,
        "an unresolvable host must record a DOWN heartbeat"
    );

    h.state.engine.stop(up_id);
    h.state.engine.stop(down_id);
}

#[tokio::test]
async fn down_transition_sends_telegram_alert() {
    let h = harness().await;

    // A fake Telegram bot API that records what it receives.
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
    let telegram_base = spawn_server(stub).await;

    let config = json!({
        "telegramServerUrl": telegram_base,
        "telegramBotToken": "TEST:TOKEN",
        "telegramChatID": "-100123",
    });
    let (notification_id,): (i64,) = sqlx::query_as(
        "INSERT INTO notifications (name, type, config) VALUES ('alerts', 'telegram', ?) RETURNING id",
    )
    .bind(config.to_string())
    .fetch_one(&h.pool)
    .await
    .unwrap();

    let (id, push_token) = create_monitor(
        &h,
        json!({
            "name": "cmn", "type": "push", "interval": 180,
            "notificationIDList": [notification_id]
        }),
    )
    .await;
    let push_token = push_token.unwrap();

    // First beat is UP: silent.
    let (status, _) = send(
        &h.app,
        request("GET", &format!("/api/push/{push_token}"), None, None),
    )
    .await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        captured.lock().unwrap().is_empty(),
        "an initial UP must not notify"
    );

    // The agent reports down: this pages.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/api/push/{push_token}?status=down&msg=power%20cut"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, 200);

    let mut alert = None;
    for _ in 0..60 {
        if let Some(body) = captured.lock().unwrap().first().cloned() {
            alert = Some(body);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let alert = alert.expect("a down transition must send a Telegram message");
    assert_eq!(alert["chat_id"], "-100123");
    let text = alert["text"].as_str().unwrap_or_default();
    assert_eq!(text, "[cmn] [🔴 Down] power cut");
    assert_eq!(alert["link_preview_options"]["is_disabled"], true);

    // The link arrived through the API's notificationIDList handling.
    let linked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM monitor_notifications WHERE monitor_id = ? AND notification_id = ?",
    )
    .bind(id)
    .bind(notification_id)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(linked, 1);
}
