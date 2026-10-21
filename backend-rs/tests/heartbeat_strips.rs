//! `GET /api/v1/monitors/heartbeat-strips`: bucketed status strips.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::Router;
use axum::http::StatusCode;
use chrono::{TimeZone, Utc};
use flatline_backend::api::strips::StripCache;
use serde_json::{Value, json};

mod common;
use common::{Harness, get_json, harness};

/// A router over the harness database with a controllable clock.
struct Fixture {
    h: Harness,
    app: Router,
    clock: Arc<AtomicI64>,
}

/// 2026-10-21T10:47:12Z; with 30-minute buckets the current one starts 10:30.
fn base_ms() -> i64 {
    Utc.with_ymd_and_hms(2026, 10, 21, 10, 47, 12)
        .unwrap()
        .timestamp_millis()
}

async fn fixture() -> Fixture {
    let h = harness().await;
    let clock = Arc::new(AtomicI64::new(base_ms()));
    let c = Arc::clone(&clock);
    let mut state = h.state.clone();
    state.strips = Arc::new(StripCache::with_clock(Arc::new(move || {
        c.load(Ordering::SeqCst)
    })));
    let app = flatline_backend::api::router(state);
    Fixture { h, app, clock }
}

impl Fixture {
    async fn get(&self, query: &str) -> (StatusCode, Value) {
        get_json(
            &self.app,
            &format!("/api/v1/monitors/heartbeat-strips{query}"),
            &self.h.token,
        )
        .await
    }

    async fn monitor(&self, kind: &str) -> i64 {
        sqlx::query_scalar("INSERT INTO monitors (name, type) VALUES ('m', ?) RETURNING id")
            .bind(kind)
            .fetch_one(&self.h.pool)
            .await
            .unwrap()
    }

    async fn beat(&self, id: i64, time: &str, status: i64) {
        sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?)")
            .bind(id)
            .bind(time)
            .bind(status)
            .execute(&self.h.pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn shape_alignment_and_start() {
    let f = fixture().await;
    let id = f.monitor("push").await;
    f.beat(id, "2026-10-21 10:40:00.000", 1).await;

    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["hours"], 24);
    assert_eq!(body["buckets"], 48);
    assert_eq!(body["bucketSeconds"], 1800);
    // 47 buckets before the 10:30 one.
    assert_eq!(body["start"], "2026-10-20T11:00:00.000Z");
    let strip = body["strips"][id.to_string()].as_array().unwrap();
    assert_eq!(strip.len(), 48);
    assert_eq!(strip[47], json!([1, 1, 0]));
    assert!(strip[..47].iter().all(Value::is_null));

    // Another width: 6 h in 36 buckets = 600 s; now is in the 10:40 bucket.
    let (_, body) = f.get("?hours=6&buckets=36").await;
    assert_eq!(body["bucketSeconds"], 600);
    assert_eq!(body["start"], "2026-10-21T04:50:00.000Z");
    let strip = body["strips"][id.to_string()].as_array().unwrap();
    assert_eq!(strip.len(), 36);
    assert_eq!(strip[35], json!([1, 1, 0]));
}

#[tokio::test]
async fn worst_status_precedence_counts_and_null_buckets() {
    let f = fixture().await;
    let id = f.monitor("push").await;
    // Bucket 47 (10:30-11:00): up + maintenance + pending -> pending.
    f.beat(id, "2026-10-21 10:30:00.000", 1).await;
    f.beat(id, "2026-10-21 10:31:00.000", 3).await;
    f.beat(id, "2026-10-21 10:32:00.000", 2).await;
    // Bucket 46 (10:00-10:30): up + down + maintenance -> down, 1 failed.
    f.beat(id, "2026-10-21 10:00:00.000", 1).await;
    f.beat(id, "2026-10-21 10:10:00.000", 0).await;
    f.beat(id, "2026-10-21 10:29:59.999", 3).await;
    // Bucket 45 (09:30-10:00): up + maintenance -> maintenance.
    f.beat(id, "2026-10-21 09:30:00.000", 1).await;
    f.beat(id, "2026-10-21 09:40:00.000", 3).await;
    // Bucket 44 empty; bucket 43 (08:30-09:00): only up, two rows.
    f.beat(id, "2026-10-21 08:30:00.000", 1).await;
    f.beat(id, "2026-10-21 08:45:00", 1).await; // imported row without ms
    // Bucket 42 (08:00-08:30): two downs.
    f.beat(id, "2026-10-21 08:00:00.000", 0).await;
    f.beat(id, "2026-10-21 08:20:00.000", 0).await;
    // Outside the window: before the first bucket, and in the future.
    f.beat(id, "2026-10-20 10:59:59.999", 0).await;
    f.beat(id, "2026-10-21 11:00:00.000", 0).await;

    let (_, body) = f.get("").await;
    let strip = body["strips"][id.to_string()].as_array().unwrap();
    assert_eq!(strip[47], json!([2, 3, 0]));
    assert_eq!(strip[46], json!([0, 3, 1]));
    assert_eq!(strip[45], json!([3, 2, 0]));
    assert!(strip[44].is_null());
    assert_eq!(strip[43], json!([1, 2, 0]));
    assert_eq!(strip[42], json!([0, 2, 2]));
    assert!(strip[0].is_null(), "the beat before the window is excluded");
    assert_eq!(strip.iter().filter(|b| !b.is_null()).count(), 5);
}

#[tokio::test]
async fn first_bucket_includes_its_exact_start_with_and_without_ms() {
    let f = fixture().await;
    let id = f.monitor("push").await;
    f.beat(id, "2026-10-20 11:00:00", 1).await;
    f.beat(id, "2026-10-20 11:00:00.000", 0).await;
    let (_, body) = f.get("").await;
    assert_eq!(body["strips"][id.to_string()][0], json!([0, 2, 1]));
}

#[tokio::test]
async fn ids_filter_unknown_ids_and_groups() {
    let f = fixture().await;
    let a = f.monitor("push").await;
    let b = f.monitor("push").await;
    let group = f.monitor("group").await;
    f.beat(a, "2026-10-21 10:40:00.000", 1).await;
    f.beat(group, "2026-10-21 10:40:00.000", 0).await;

    let (status, body) = f.get(&format!("?ids={a},{group},9999")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let strips = body["strips"].as_object().unwrap();
    assert_eq!(strips.len(), 2, "unknown id is absent: {body}");
    assert_eq!(strips[&a.to_string()][47], json!([1, 1, 0]));
    assert_eq!(strips[&group.to_string()][47], json!([0, 1, 1]));
    assert!(!strips.contains_key(&b.to_string()));

    let (_, body) = f.get("").await;
    assert_eq!(body["strips"].as_object().unwrap().len(), 3);

    let (_, body) = f.get("?ids=9999").await;
    assert_eq!(body["ok"], true);
    assert!(body["strips"].as_object().unwrap().is_empty());
}

#[tokio::test]
async fn invalid_requests_are_400() {
    let f = fixture().await;
    f.monitor("push").await;
    let many = (1..=201)
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    for query in [
        "?ids=".to_string(),
        "?ids=a".to_string(),
        "?ids=1,,2".to_string(),
        "?ids=-1".to_string(),
        "?ids=0".to_string(),
        format!("?ids={many}"),
        "?hours=0".to_string(),
        "?hours=169".to_string(),
        "?hours=abc".to_string(),
        "?hours=1.5".to_string(),
        "?buckets=0".to_string(),
        "?buckets=121".to_string(),
        "?buckets=x".to_string(),
        // 3600 / 7 is not whole.
        "?hours=1&buckets=7".to_string(),
        // 30-second buckets.
        "?hours=1&buckets=120".to_string(),
    ] {
        let (status, body) = f.get(&query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "bad_request");
    }

    let ok = (1..=200)
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let (status, _) = f.get(&format!("?ids={ok}&hours=168&buckets=120")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn requires_a_token_and_is_not_shadowed_by_monitor_id() {
    let f = fixture().await;
    let id = f.monitor("push").await;

    let (status, _) = get_json(&f.app, "/api/v1/monitors/heartbeat-strips", "wrong").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Had `{id}` matched, "heartbeat-strips" would fail integer parsing.
    let (status, body) = f.get("").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["strips"].get(id.to_string()).is_some());
    assert!(body.get("monitor").is_none());
}

#[tokio::test]
async fn cache_serves_within_a_bucket_but_never_across_a_boundary() {
    let f = fixture().await;
    let id = f.monitor("push").await;
    f.beat(id, "2026-10-21 10:40:00.000", 1).await;

    let (_, first) = f.get(&format!("?ids={id}")).await;
    assert_eq!(first["strips"][id.to_string()][47], json!([1, 1, 0]));

    // A new beat inside the TTL and bucket is not visible yet: cached.
    f.beat(id, "2026-10-21 10:41:00.000", 0).await;
    f.clock.fetch_add(5_000, Ordering::SeqCst);
    let (_, cached) = f.get(&format!("?ids={id}")).await;
    assert_eq!(cached, first);

    // Past the TTL it is recomputed.
    f.clock.fetch_add(6_000, Ordering::SeqCst);
    let (_, fresh) = f.get(&format!("?ids={id}")).await;
    assert_eq!(fresh["strips"][id.to_string()][47], json!([0, 2, 1]));

    // Cross the 11:00 boundary within the TTL of a fresh computation: the
    // strip must shift by one bucket instead of being served stale.
    let boundary = Utc
        .with_ymd_and_hms(2026, 10, 21, 11, 0, 0)
        .unwrap()
        .timestamp_millis();
    f.clock.store(boundary - 1_000, Ordering::SeqCst);
    let (_, before) = f.get(&format!("?ids={id}")).await;
    f.clock.store(boundary + 1_000, Ordering::SeqCst);
    let (_, after) = f.get(&format!("?ids={id}")).await;
    assert_ne!(before["start"], after["start"]);
    assert_eq!(after["start"], "2026-10-20T11:30:00.000Z");
    let strip = after["strips"][id.to_string()].as_array().unwrap();
    assert!(strip[47].is_null());
    assert_eq!(strip[46], json!([0, 2, 1]));
}
