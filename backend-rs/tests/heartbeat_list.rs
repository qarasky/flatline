//! `GET /api/v1/monitors/{id}/heartbeats`: newest first by time (A6).

use axum::http::StatusCode;

mod common;
use common::{get_json, harness};

async fn insert_monitor(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn insert_beat(pool: &sqlx::SqlitePool, monitor_id: i64, time: &str, status: i64) {
    sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?)")
        .bind(monitor_id)
        .bind(time)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn heartbeats_are_ordered_by_time_not_insertion() {
    let h = harness().await;
    let id = insert_monitor(&h.pool).await;

    // Inserted out of time order (an imported or backfilled history): row
    // ids no longer follow time.
    insert_beat(&h.pool, id, "2026-10-20 10:00:02.000", 1).await;
    insert_beat(&h.pool, id, "2026-10-20 10:00:00.000", 0).await;
    insert_beat(&h.pool, id, "2026-10-20 10:00:03.000", 1).await;
    insert_beat(&h.pool, id, "2026-10-20 10:00:01.000", 2).await;

    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/heartbeats"),
        &h.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let times: Vec<&str> = body["heartbeats"]
        .as_array()
        .unwrap()
        .iter()
        .map(|beat| beat["time"].as_str().unwrap())
        .collect();
    assert_eq!(
        times,
        [
            "2026-10-20 10:00:03.000",
            "2026-10-20 10:00:02.000",
            "2026-10-20 10:00:01.000",
            "2026-10-20 10:00:00.000",
        ]
    );
    assert_eq!(body["total"], 4);

    // A full page still reports the true total.
    let (_, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/{id}/heartbeats?limit=2"),
        &h.token,
    )
    .await;
    assert_eq!(body["count"], 2);
    assert_eq!(body["total"], 4);
    assert_eq!(body["heartbeats"][0]["time"], "2026-10-20 10:00:03.000");
}

#[tokio::test]
async fn monitor_list_reports_uptime_for_every_monitor() {
    let h = harness().await;
    let an_hour_ago = (chrono::Utc::now() - chrono::Duration::hours(1))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    for _ in 0..7 {
        let id = insert_monitor(&h.pool).await;
        insert_beat(&h.pool, id, &an_hour_ago, 1).await;
    }
    let (status, body) = get_json(&h.app, "/api/v1/monitors", &h.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let monitors = body["monitors"].as_array().unwrap();
    assert_eq!(monitors.len(), 7);
    // The uptime batch must line up with its monitor; each one is all-up.
    for monitor in monitors {
        assert_eq!(monitor["uptime24h"], 1.0, "{monitor}");
    }
}
