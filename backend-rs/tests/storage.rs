//! Storage and telemetry contract (audit 2026-10, S findings): push status
//! codes under storage failure, batched retention, batched monitor deletes,
//! the archive clock across cache misses, and the agent-ack reset rule.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::{Duration as ChronoDuration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;

mod common;
use common::{Harness, harness, request, send};

async fn create_push_monitor(h: &Harness) -> (i64, String) {
    let (status, response) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "host", "type": "push", "interval": 180 })),
        ),
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

/// POST a raw body to the push route; returns status, `Retry-After`, JSON.
async fn push_raw(h: &Harness, uri: &str, body: &str) -> (StatusCode, Option<u64>, Value) {
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let retry_after = response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        retry_after,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn count(pool: &SqlitePool, sql: &str, id: i64) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn fail_inserts_into(pool: &SqlitePool, table: &str) {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TRIGGER fail_{table} BEFORE INSERT ON {table}
         BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
    )))
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn push_storage_failures_answer_503_with_retry_after() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h).await;
    let uri = format!("/api/push/{token}");
    let telemetry = format!("/api/push/{token}?telemetry=1");
    let sample = json!({ "metrics": { "cpu": { "percent": 12.0 } } }).to_string();

    // Validation failures stay 400 and carry no Retry-After.
    let (status, retry, body) = push_raw(&h, &uri, r#"{"metrics":"nope"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(retry, None);

    // The metrics write fails: the heartbeat stands, the answer is 503.
    fail_inserts_into(&h.pool, "metrics_raw").await;
    let beats_before = count(
        &h.pool,
        "SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?",
        id,
    )
    .await;
    let (status, retry, body) = push_raw(&h, &uri, &sample).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let retry = retry.expect("503 carries Retry-After");
    assert!((5..=30).contains(&retry), "Retry-After {retry}");
    assert_eq!(body["ok"], false);
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?",
            id
        )
        .await,
        beats_before + 1,
        "the heartbeat is recorded before the metrics fail"
    );

    // The telemetry fast path (fresh UP beat, no heartbeat row) too.
    let (status, retry, body) = push_raw(&h, &telemetry, &sample).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(retry.is_some());

    // The heartbeat write itself fails: 503, never 500 or 400.
    fail_inserts_into(&h.pool, "heartbeats").await;
    let (status, retry, body) = push_raw(&h, &uri, "").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(retry.is_some());
}

#[tokio::test]
async fn non_json_push_body_is_rejected_but_the_beat_counts() {
    let h = harness().await;
    let (id, token) = create_push_monitor(&h).await;
    let uri = format!("/api/push/{token}?telemetry=1");

    let (status, retry, body) = push_raw(&h, &uri, "{\"metrics\": {\"cpu\": ").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(retry, None);
    assert!(
        body["msg"].as_str().unwrap().contains("not valid JSON"),
        "{body}"
    );
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?",
            id
        )
        .await,
        1,
        "the host is alive: the heartbeat is recorded"
    );
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?",
            id
        )
        .await,
        0
    );

    // Empty and whitespace-only bodies are plain heartbeats.
    let (status, _, _) = push_raw(&h, &format!("/api/push/{token}"), "").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = push_raw(&h, &format!("/api/push/{token}"), " \n").await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn batched_heartbeat_prune_keeps_each_monitors_boundary_beat() {
    let h = harness().await;
    let (a, _) = create_push_monitor(&h).await;
    let (b, _) = create_push_monitor(&h).await;
    let (c, _) = create_push_monitor(&h).await;

    let now = Utc::now();
    let stamp = |days: i64, seconds: i64| {
        (now - ChronoDuration::days(days) + ChronoDuration::seconds(seconds))
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string()
    };
    let insert = |monitor: i64, time: String| {
        let pool = h.pool.clone();
        async move {
            sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, 1)")
                .bind(monitor)
                .bind(time)
                .execute(&pool)
                .await
                .unwrap();
        }
    };

    // a: 25 old beats (many batches of 4) and 3 recent ones.
    for i in 0..25 {
        insert(a, stamp(200, i * 60)).await;
    }
    for i in 0..3 {
        insert(a, stamp(1, i)).await;
    }
    // b: only old beats; its newest one is the boundary and survives.
    for i in 0..9 {
        insert(b, stamp(150, i)).await;
    }
    // c: only recent beats; untouched.
    for i in 0..5 {
        insert(c, stamp(2, i)).await;
    }
    // Two old beats sharing the newest timestamp: the higher id is kept.
    insert(c, stamp(120, 0)).await;
    insert(c, stamp(120, 0)).await;

    let deleted = flatline_backend::heartbeats::prune_batched(&h.pool, 90, 4)
        .await
        .unwrap();
    assert_eq!(deleted, 24 + 8 + 1);

    let survivors = |monitor: i64| {
        let pool = h.pool.clone();
        async move {
            sqlx::query_as::<_, (i64, String)>(
                "SELECT id, time FROM heartbeats WHERE monitor_id = ? ORDER BY time, id",
            )
            .bind(monitor)
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    let a_left = survivors(a).await;
    assert_eq!(a_left.len(), 4, "boundary + 3 recent");
    assert_eq!(
        a_left[0].1,
        stamp(200, 24 * 60),
        "the newest old beat is kept"
    );
    let b_left = survivors(b).await;
    assert_eq!(b_left.len(), 1);
    assert_eq!(b_left[0].1, stamp(150, 8));
    let c_left = survivors(c).await;
    assert_eq!(c_left.len(), 6);
    let max_old_id: i64 =
        sqlx::query_scalar("SELECT MAX(id) FROM heartbeats WHERE monitor_id = ? AND time = ?")
            .bind(c)
            .bind(stamp(120, 0))
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(c_left[0].0, max_old_id, "ties keep the higher id");

    // Idempotent: a second pass has nothing left to delete.
    assert_eq!(
        flatline_backend::heartbeats::prune_batched(&h.pool, 90, 4)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn monitor_delete_removes_history_in_batches() {
    let h = harness().await;
    let (id, _) = create_push_monitor(&h).await;
    let (other, _) = create_push_monitor(&h).await;

    let rows = flatline_backend::db::DELETE_BATCH * 2 + 7;
    for monitor in [id, other] {
        sqlx::query(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
             INSERT INTO metrics_raw (monitor_id, time, payload)
             SELECT ?, '2026-10-12 20:00:00.000', '{}' FROM n",
        )
        .bind(rows)
        .bind(monitor)
        .execute(&h.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, '2026-10-12 20:00:00', 1)",
        )
        .bind(monitor)
        .execute(&h.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO metrics_hourly (monitor_id, time, samples) VALUES (?, '2026-10-12 20:00:00.000', 1)",
        )
        .bind(monitor)
        .execute(&h.pool)
        .await
        .unwrap();
    }

    let (status, body) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{id}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    for (table, expected) in [
        ("metrics_raw", 0),
        ("metrics_hourly", 0),
        ("heartbeats", 0),
        ("monitors", 0),
    ] {
        let column = if table == "monitors" {
            "id"
        } else {
            "monitor_id"
        };
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?");
        assert_eq!(count(&h.pool, &sql, id).await, expected, "{table}");
    }
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?",
            other
        )
        .await,
        rows,
        "other monitors keep their history"
    );
}

#[tokio::test]
async fn cache_miss_keeps_the_archive_clock() {
    // S6: an evicted (or restarted) monitor used to archive every push until
    // its in-memory archive clock re-warmed.
    let h = harness().await;
    let (id, token) = create_push_monitor(&h).await;
    let uri = format!("/api/push/{token}?telemetry=1");
    let sample = json!({ "metrics": { "cpu": { "percent": 12.0 } } }).to_string();

    let (status, _, _) = push_raw(&h, &uri, &sample).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?",
            id
        )
        .await,
        1
    );

    h.state.metrics.forget(id);
    for _ in 0..3 {
        let (status, _, _) = push_raw(&h, &uri, &sample).await;
        assert_eq!(status, StatusCode::OK);
    }
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?",
            id
        )
        .await,
        1,
        "live samples inside the 30 s cadence do not archive after a cache miss"
    );
    assert!(
        h.state.metrics.latest_json(id).is_some(),
        "the cache re-warms"
    );
}

#[tokio::test]
async fn on_time_samples_leave_one_marker_per_hour() {
    // S7: every archived row used to write its dirty marker as a separate
    // commit; on-time rows now mark their hour once.
    let h = harness().await;
    let (id, _) = create_push_monitor(&h).await;
    let now = Utc::now().timestamp_millis();
    for offset in 0..3 {
        let time = flatline_backend::metrics::sql_time_millis(now - offset * 1000);
        h.state
            .metrics
            .store(id, &time, &json!({ "cpu": { "percent": 1.0 } }), false)
            .await
            .unwrap();
    }
    assert_eq!(
        count(
            &h.pool,
            "SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?",
            id
        )
        .await,
        3
    );
    let max_id: i64 = sqlx::query_scalar("SELECT MAX(id) FROM metrics_rollup_dirty")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    // Sample times can straddle an hour edge; either way, far fewer marker
    // writes than rows (ids are AUTOINCREMENT: every write consumed one).
    assert!(max_id <= 2, "one marker write per hour, got {max_id}");

    // A late row (an earlier hour) always marks its hour.
    let late = flatline_backend::metrics::sql_time_millis(now - 5 * 3_600_000);
    h.state
        .metrics
        .store(id, &late, &json!({ "cpu": { "percent": 1.0 } }), false)
        .await
        .unwrap();
    let late_hour = flatline_backend::metrics::sql_time_millis(
        flatline_backend::metrics::rollup::hour_start(now - 5 * 3_600_000),
    );
    let marked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM metrics_rollup_dirty WHERE monitor_id = ? AND hour = ?",
    )
    .bind(id)
    .bind(late_hour)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(marked, 1);
}

#[tokio::test]
async fn stale_acks_reset_only_when_a_counter_moves_back() {
    let h = harness().await;
    let (id, _) = create_push_monitor(&h).await;
    let store = |failed: u64, seconds_ago: i64| {
        let metrics = h.state.metrics.clone();
        async move {
            let time = flatline_backend::metrics::sql_time_millis(
                Utc::now().timestamp_millis() - seconds_ago * 1000,
            );
            metrics
                .store(
                    id,
                    &time,
                    &json!({ "agent": { "failedPushes": failed, "collectorErrors": { "gpu": failed } } }),
                    true,
                )
                .await
                .unwrap();
        }
    };
    let acks = || {
        let pool = h.pool.clone();
        async move {
            sqlx::query_as::<_, (i64, String)>(
                "SELECT push_failures_ack, collector_errors_ack FROM monitors WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    store(5, 3).await;
    sqlx::query(
        "UPDATE monitors SET push_failures_ack = 5, collector_errors_ack = '{\"gpu\":5}' WHERE id = ?",
    )
    .bind(id)
    .execute(&h.pool)
    .await
    .unwrap();

    // Counters steady or growing: the acks stand.
    store(5, 2).await;
    store(6, 1).await;
    assert_eq!(acks().await, (5, "{\"gpu\":5}".to_string()));

    // The agent restarted: counters went back, so the stale acks go.
    store(0, 0).await;
    assert_eq!(acks().await, (0, "{}".to_string()));
}
