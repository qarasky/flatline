//! Public status-page and badge routes: unpublished pages stay private
//! (A14), absurd badge durations are a 4xx rather than a panic (A4), and
//! cached data never bypasses the gate (A3).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

mod common;
use common::{Harness, harness, request, send};

/// A page with one public group holding one monitor with a recent beat.
async fn seed_page(h: &Harness, slug: &str, published: i64) -> (i64, i64) {
    let monitor_id: i64 = sqlx::query_scalar(
        "INSERT INTO monitors (name, type, url) VALUES ('site', 'http', 'https://x.example') RETURNING id",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let page_id: i64 = sqlx::query_scalar(
        "INSERT INTO status_pages (slug, title, published) VALUES (?, 'Page', ?) RETURNING id",
    )
    .bind(slug)
    .bind(published)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let group_id: i64 = sqlx::query_scalar(
        "INSERT INTO status_page_groups (status_page_id, name, weight, public) VALUES (?, 'G', 1, 1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO status_page_monitors (group_id, monitor_id, send_url, weight) VALUES (?, ?, 0, 1)",
    )
    .bind(group_id)
    .bind(monitor_id)
    .execute(&h.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO status_page_cnames (status_page_id, domain) VALUES (?, ?)")
        .bind(page_id)
        .bind(format!("{slug}.example"))
        .execute(&h.pool)
        .await
        .unwrap();
    let time = (chrono::Utc::now() - chrono::Duration::minutes(5))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    sqlx::query("INSERT INTO heartbeats (monitor_id, time, status, ping) VALUES (?, ?, 1, 20)")
        .bind(monitor_id)
        .bind(time)
        .execute(&h.pool)
        .await
        .unwrap();
    (page_id, monitor_id)
}

async fn raw(h: &Harness, uri: &str, token: Option<&str>) -> (StatusCode, String) {
    let response = h
        .app
        .clone()
        .oneshot(request("GET", uri, token, None))
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&body).to_string())
}

#[tokio::test]
async fn unpublished_pages_are_404_to_the_public_but_visible_to_operators() {
    let h = harness().await;
    let (_, monitor_id) = seed_page(&h, "draft", 0).await;

    for uri in [
        "/api/status-page/draft",
        "/api/status-page/heartbeat/draft",
        "/api/status-page/draft/incident-history",
        "/api/status-page/draft/manifest.json",
        "/api/status-page/draft/badge",
    ] {
        let (status, _) = raw(&h, uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} must hide a draft");
        let (status, _) = raw(&h, uri, Some("flatline_not_a_token")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} with a bad token");
        let (status, body) = raw(&h, uri, Some(&h.token)).await;
        assert_eq!(status, StatusCode::OK, "{uri} for an operator: {body}");
    }

    // Host mapping does not leak the draft's slug.
    let (_, body) = send(
        &h.app,
        request(
            "GET",
            "/api/status-page/resolve-host?host=draft.example",
            None,
            None,
        ),
    )
    .await;
    assert_eq!(body["matched"], false);

    // Its monitor is not public for badges either.
    let (_, svg) = raw(&h, &format!("/api/badge/{monitor_id}/status"), None).await;
    assert!(svg.contains("N/A"), "{svg}");

    // Unlock does not confirm the page exists.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/status-pages/unlock/draft")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from("password=x"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn publishing_and_locking_apply_immediately_despite_the_cache() {
    let h = harness().await;
    let (page_id, monitor_id) = seed_page(&h, "live", 1).await;

    let (status, _) = raw(&h, "/api/status-page/live", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = raw(&h, "/api/status-page/heartbeat/live", None).await;
    assert_eq!(status, StatusCode::OK);

    // Data is cached, so a renamed title is not visible for a few seconds...
    sqlx::query("UPDATE status_pages SET title = 'Renamed' WHERE id = ?")
        .bind(page_id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (_, body) = send(&h.app, request("GET", "/api/status-page/live", None, None)).await;
    assert_eq!(
        body["config"]["title"], "Page",
        "served from the short cache"
    );

    // ...but the gate is not: unpublishing hides the page at once.
    sqlx::query("UPDATE status_pages SET published = 0 WHERE id = ?")
        .bind(page_id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = raw(&h, "/api/status-page/live", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Republish and lock it: a password applies at once too.
    sqlx::query("UPDATE status_pages SET published = 1, password = ? WHERE id = ?")
        .bind(bcrypt::hash("pw", 4).unwrap())
        .bind(page_id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (status, _) = raw(&h, "/api/status-page/heartbeat/live", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (_, svg) = raw(&h, &format!("/api/badge/{monitor_id}/uptime"), None).await;
    assert!(svg.contains("100.0%"), "{svg}");
}

#[tokio::test]
async fn absurd_badge_durations_are_rejected_or_clamped_never_a_panic() {
    let h = harness().await;
    let (_, monitor_id) = seed_page(&h, "badges", 1).await;

    for duration in [
        "1000000y",
        "1000000000000000y",
        "9223372036854775807h",
        "1é",
        "0d",
    ] {
        for kind in ["uptime", "ping"] {
            let uri = format!("/api/badge/{monitor_id}/{kind}/{duration}");
            let (status, body) = raw(&h, &uri, None).await;
            if duration == "1000000y" {
                // Representable: clamped to retention and answered.
                assert_eq!(status, StatusCode::OK, "{uri}: {body}");
                assert!(body.starts_with("<svg"), "{uri}: {body}");
            } else {
                assert!(status.is_client_error(), "{uri} answered {status}");
            }
        }
    }

    // Avg-response caps hours already; huge input falls back, not panics.
    let (status, _) = raw(
        &h,
        &format!("/api/badge/{monitor_id}/avg-response/99999999999999999999"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn resolve_host_answers_503_on_a_database_error_not_unmapped() {
    let h = harness().await;
    seed_page(&h, "mapped", 1).await;

    let uri = "/api/status-page/resolve-host?host=mapped.example";
    let (status, body) = send(&h.app, request("GET", uri, None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["slug"], "mapped");

    // A genuinely unmapped host is a successful null.
    let (status, body) = send(
        &h.app,
        request(
            "GET",
            "/api/status-page/resolve-host?host=nobody.example",
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["slug"], serde_json::Value::Null);
    assert_eq!(body["matched"], false);

    // A failing database is not "unmapped".
    h.pool.close().await;
    let (status, body) = send(&h.app, request("GET", uri, None, None)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "unavailable");
    assert!(
        body.get("slug").is_none(),
        "no slug field on an error: {body}"
    );
}
