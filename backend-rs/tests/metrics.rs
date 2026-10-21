//! M3 integration tests: metrics ingest, the live cache, bulk latest, the
//! two-tier summary, threshold alerts and the 400 dropped-metrics contract.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::Json;
use axum::routing::post;
use common::{get_json, harness, request, send};
use serde_json::{Value, json};
use sqlx::SqlitePool;

/// Create a monitor through the API and return `(id, pushToken)`.
async fn create_push_monitor(h: &common::Harness, extra: Value) -> (i64, String) {
    let mut body = json!({ "name": "host", "type": "push", "interval": 180 });
    if let Some(object) = body.as_object_mut()
        && let Some(extra) = extra.as_object()
    {
        for (key, value) in extra {
            object.insert(key.clone(), value.clone());
        }
    }
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
            .unwrap()
            .to_string(),
    )
}

async fn push(
    h: &common::Harness,
    token: &str,
    query: &str,
    body: Option<Value>,
) -> (axum::http::StatusCode, Value) {
    send(
        &h.app,
        request("POST", &format!("/api/push/{token}{query}"), None, body),
    )
    .await
}

async fn raw_count(pool: &SqlitePool, id: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn heartbeat_count(pool: &SqlitePool, id: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn legacy_push_stores_metrics_and_serves_latest() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    let (status, body) = push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "cpu": { "percent": 42.5 }, "mem": { "percent": 60.0 } } })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(heartbeat_count(&h.pool, id).await, 1);
    assert_eq!(raw_count(&h.pool, id).await, 1, "legacy pushes archive");

    // Cached latest, with the peak tracker attached.
    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics/latest"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(body["monitorId"], id);
    assert_eq!(body["metrics"]["cpu"]["percent"], 42.5);
    assert!(body["time"].is_string());
    assert_eq!(body["cpuPeak10m"]["percent"], 42.5);
    assert!(body["cpuPeak10m"]["at"].is_string());

    // Raw history endpoint.
    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics?hours=1"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["count"], 1);
    assert_eq!(body["capped"], false);
    assert_eq!(body["metrics"][0]["metrics"]["mem"]["percent"], 60.0);
}

#[tokio::test]
async fn live_telemetry_updates_latest_without_archiving_every_sample() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    // First telemetry push: no previous beat, so the full path runs and the
    // first sample archives.
    let (status, _) = push(
        &h,
        &token,
        "?telemetry=1",
        Some(json!({ "metrics": { "cpu": { "percent": 10.0 } } })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(raw_count(&h.pool, id).await, 1);

    // Second push lands on the fast path: latest moves, archive does not.
    let (status, _) = push(
        &h,
        &token,
        "?telemetry=1",
        Some(json!({ "metrics": { "cpu": { "percent": 20.0 } } })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        raw_count(&h.pool, id).await,
        1,
        "live telemetry archives at 30s resolution"
    );

    let (_, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics/latest"),
        &h.token,
    )
    .await;
    assert_eq!(body["metrics"]["cpu"]["percent"], 20.0);
}

#[tokio::test]
async fn concurrent_live_samples_archive_once() {
    // The audit's reproduction: ten concurrent samples for one monitor all
    // read the same stale archive clock before awaiting storage, so every
    // request archived a row. Ingest is serialized per monitor now; the
    // gate holds however the requests interleave.
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    let mut set = tokio::task::JoinSet::new();
    for i in 0..10 {
        let app = h.app.clone();
        let token = token.clone();
        set.spawn(async move {
            common::send(
                &app,
                common::request(
                    "POST",
                    &format!("/api/push/{token}?telemetry=1"),
                    None,
                    Some(json!({ "metrics": { "cpu": { "percent": i as f64 } } })),
                ),
            )
            .await
        });
    }
    while let Some(joined) = set.join_next().await {
        let (status, body) = joined.unwrap();
        assert_eq!(status, 200, "push failed: {body}");
    }

    assert_eq!(
        raw_count(&h.pool, id).await,
        1,
        "concurrent live samples must archive exactly once"
    );
}

#[tokio::test]
async fn sampled_at_backfill_archives_at_sample_time() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    let sampled = (chrono::Utc::now() - chrono::Duration::seconds(45))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let (status, _) = push(
        &h,
        &token,
        "?telemetry=1",
        Some(json!({
            "metrics": { "cpu": { "percent": 33.0 }, "sampledAt": sampled }
        })),
    )
    .await;
    assert_eq!(status, 200);

    let time: String = sqlx::query_scalar("SELECT time FROM metrics_raw WHERE monitor_id = ?")
        .bind(id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    // The stored time is the agent's sample time, in SQL format.
    assert_eq!(time, sampled.replace('T', " ").trim_end_matches('Z'));
}

#[tokio::test]
async fn counters_derive_cpu_and_rates_server_side() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    // Two snapshots one second of CPU time apart; the compat percent lies.
    let (status, _) = push(
        &h,
        &token,
        "?telemetry=1",
        Some(json!({
            "metrics": {
                "cpu": { "percent": 1.0, "counters": { "total": 1000, "idle": 400 } },
                "net": [ { "iface": "eth0", "rxBytes": 1000, "txBytes": 2000 } ]
            }
        })),
    )
    .await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(30)).await;

    let (status, _) = push(
        &h,
        &token,
        "?telemetry=1",
        Some(json!({
            "metrics": {
                "cpu": { "percent": 1.0, "counters": { "total": 1500, "idle": 600 } },
                "net": [ { "iface": "eth0", "rxBytes": 3000, "txBytes": 4000 } ]
            }
        })),
    )
    .await;
    assert_eq!(status, 200);

    let (_, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics/latest"),
        &h.token,
    )
    .await;
    assert_eq!(
        body["metrics"]["cpu"]["percent"], 60.0,
        "the server derives the percentage from counters"
    );
    assert!(
        body["metrics"]["netRate"]["rxBytesPerSec"]
            .as_f64()
            .unwrap()
            > 0.0,
        "net rate derived between pushes"
    );
    assert!(
        body["metrics"]["netRate"]["windowSeconds"]
            .as_f64()
            .unwrap()
            > 0.0
    );
}

#[tokio::test]
async fn oversized_metrics_400_but_the_heartbeat_is_recorded() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    let big = "x".repeat(70 * 1024);
    let (status, body) = push(&h, &token, "", Some(json!({ "metrics": { "blob": big } }))).await;
    assert_eq!(status, 400);
    assert_eq!(body["ok"], false);
    let message = body["msg"].as_str().unwrap();
    assert!(
        message.starts_with("Heartbeat recorded, metrics dropped:"),
        "unexpected message: {message}"
    );

    assert_eq!(heartbeat_count(&h.pool, id).await, 1, "the host is alive");
    assert_eq!(raw_count(&h.pool, id).await, 0, "the payload is dropped");
}

#[tokio::test]
async fn bulk_latest_returns_null_for_unknown_and_empty() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;
    let (empty_id, _) = create_push_monitor(&h, json!({ "name": "empty" })).await;

    push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "cpu": { "percent": 5.0 } } })),
    )
    .await;

    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/metrics/latest?ids={id},{empty_id},9999"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["count"], 3);
    assert_eq!(
        body["samples"][id.to_string()]["metrics"]["cpu"]["percent"],
        5.0
    );
    assert!(body["samples"][empty_id.to_string()].is_null());
    assert!(body["samples"]["9999"].is_null());

    let (status, _) = get_json(&h.app, "/api/v1/monitors/metrics/latest?ids=", &h.token).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn summary_uses_raw_then_hourly_tiers() {
    let h = harness().await;
    let (id, _) = create_push_monitor(&h, json!({})).await;

    let now = chrono::Utc::now().timestamp_millis();
    let stamp = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string()
    };
    for (offset, cpu) in [(600_000_i64, 10.0), (300_000, 20.0), (60_000, 40.0)] {
        sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
            .bind(id)
            .bind(stamp(now - offset))
            .bind(json!({ "cpu": { "percent": cpu }, "mem": { "percent": 50.0 } }).to_string())
            .execute(&h.pool)
            .await
            .unwrap();
    }

    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics/summary?hours=1"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        body["basis"]
            .as_str()
            .unwrap()
            .contains("archived snapshots")
    );
    assert_eq!(body["samples"], 3);
    assert_eq!(body["stats"]["cpu"]["min"], 10.0);
    assert_eq!(body["stats"]["cpu"]["max"], 40.0);
    assert_eq!(body["percentileMethod"], "nearest-rank");
    assert!(!body["series"].as_array().unwrap().is_empty());

    // Seed the long tier and ask for a window beyond a week.
    for (hours_ago, cpu_avg) in [(100_i64, 50.0), (101, 30.0)] {
        sqlx::query(
            "INSERT INTO metrics_hourly (monitor_id, time, cpu_min, cpu_max, cpu_avg, samples)
             VALUES (?, ?, ?, ?, ?, 10)",
        )
        .bind(id)
        .bind(stamp(now - hours_ago * 3_600_000))
        .bind(cpu_avg - 5.0)
        .bind(cpu_avg + 25.0)
        .bind(cpu_avg)
        .execute(&h.pool)
        .await
        .unwrap();
    }

    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics/summary?hours=200"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert!(body["basis"].as_str().unwrap().contains("hourly rollups"));
    assert_eq!(body["samples"], 20, "samples report raw readings rolled up");
    assert_eq!(
        body["stats"]["cpu"]["max"], 75.0,
        "peak is the true maximum"
    );
    assert_eq!(body["stats"]["cpu"]["mean"], 40.0);

    // hours validation.
    let (status, _) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/metrics/summary?hours=99999"),
        &h.token,
    )
    .await;
    assert_eq!(status, 400);
}

/// A fake Telegram bot API: returns its base URL and the captured messages.
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

/// Create a telegram notification pointing at `base_url`.
async fn alert_notification(pool: &SqlitePool, base_url: &str) -> i64 {
    let (notification_id,): (i64,) = sqlx::query_as(
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
    .fetch_one(pool)
    .await
    .unwrap();
    notification_id
}

#[tokio::test]
async fn threshold_alerts_debounce_page_and_recover() {
    let h = harness().await;
    let (base_url, captured) = alert_stub().await;
    let notification_id = alert_notification(&h.pool, &base_url).await;

    let (id, token) = create_push_monitor(
        &h,
        json!({
            "name": "hot-box",
            "metricCpuThreshold": 90,
            "notificationIDList": [notification_id],
        }),
    )
    .await;

    // A breach above the threshold: the episode starts silently.
    push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "cpu": { "percent": 95.0 } } })),
    )
    .await;
    let monitor: flatline_backend::monitors::Monitor =
        sqlx::query_as("SELECT * FROM monitors WHERE id = ?")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();

    let now = chrono::Utc::now().timestamp_millis();
    h.state.metrics.evaluate_alerts_at(&monitor, now).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        captured.lock().unwrap().is_empty(),
        "debounce must hold for 60s"
    );

    h.state
        .metrics
        .evaluate_alerts_at(&monitor, now + 61_000)
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let messages: Vec<String> = captured
        .lock()
        .unwrap()
        .iter()
        .filter_map(|body| body["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(messages.len(), 1, "one alert after the debounce");
    assert_eq!(
        messages[0],
        "[⚠️ METRIC] [Ungrouped] [hot-box]\n[cpu] [CPU 95% ≥ threshold 90%]"
    );

    // Recovery below threshold - hysteresis.
    push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "cpu": { "percent": 80.0 } } })),
    )
    .await;
    h.state
        .metrics
        .evaluate_alerts_at(&monitor, now + 62_000)
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let messages: Vec<String> = captured
        .lock()
        .unwrap()
        .iter()
        .filter_map(|body| body["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1],
        "[✅ METRIC] [Ungrouped] [hot-box]\n[cpu] [CPU recovered: 80% (threshold 90%)]"
    );
}

#[tokio::test]
async fn stale_backfill_does_not_page() {
    // The audit's scenario: a reconnecting agent drains historical samples
    // oldest-first, and a historical high-load stretch satisfied the
    // debounce while the host had already recovered. Stale samples are
    // archived but pause the debounce; live readings resume it.
    let h = harness().await;
    let (base_url, captured) = alert_stub().await;
    let notification_id = alert_notification(&h.pool, &base_url).await;

    let (id, token) = create_push_monitor(
        &h,
        json!({
            "name": "backfill-box",
            "metricCpuThreshold": 90,
            "notificationIDList": [notification_id],
        }),
    )
    .await;
    let monitor: flatline_backend::monitors::Monitor =
        sqlx::query_as("SELECT * FROM monitors WHERE id = ?")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();

    let now = chrono::Utc::now().timestamp_millis();
    let backfill = flatline_backend::metrics::sql_time_millis(now - 10 * 60_000);

    // Ten minutes old and above the threshold: archived, never paged.
    let (status, _) = push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "sampledAt": backfill, "cpu": { "percent": 95.0 } } })),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        raw_count(&h.pool, id).await,
        1,
        "backfill is still archived"
    );

    h.state.metrics.evaluate_alerts_at(&monitor, now).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        captured.lock().unwrap().is_empty(),
        "a stale reading must not alert"
    );

    // A backlog that takes over a minute of receive time to drain must not
    // add up to a sustained-breach alert either (the audit reproduction).
    let later = flatline_backend::metrics::sql_time_millis(now - 9 * 60_000);
    push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "sampledAt": later, "cpu": { "percent": 96.0 } } })),
    )
    .await;
    h.state
        .metrics
        .evaluate_alerts_at(&monitor, now + 61_000)
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        captured.lock().unwrap().is_empty(),
        "stale telemetry must pause the debounce instead of completing it"
    );

    // Live telemetry resumes: the debounce starts from the live sample and
    // alerts a window later.
    push(
        &h,
        &token,
        "",
        Some(json!({ "metrics": { "cpu": { "percent": 95.0 } } })),
    )
    .await;
    let live = chrono::Utc::now().timestamp_millis();
    h.state.metrics.evaluate_alerts_at(&monitor, live).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        captured.lock().unwrap().is_empty(),
        "a fresh breach still debounces"
    );

    h.state
        .metrics
        .evaluate_alerts_at(&monitor, live + 61_000)
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        captured.lock().unwrap().len(),
        1,
        "live readings resume the debounce and alert"
    );
}

#[tokio::test]
async fn metrics_sse_event_carries_the_sample_and_peak() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h, json!({})).await;

    let mut receiver = h.state.events.subscribe();
    push(
        &h,
        &token,
        "?telemetry=1",
        Some(json!({ "metrics": { "cpu": { "percent": 77.0 } } })),
    )
    .await;

    // The first telemetry push also records a heartbeat, so drain until the
    // metrics event arrives.
    let mut event = receiver.try_recv().expect("events must publish").json();
    while event["type"] != "metrics" {
        event = receiver
            .try_recv()
            .expect("a metrics event must publish")
            .json();
    }
    assert_eq!(event["monitorId"], id);
    assert_eq!(event["metrics"]["cpu"]["percent"], 77.0);
    assert_eq!(event["cpuPeak10m"]["percent"], 77.0);
    assert!(event["time"].is_string());
}
