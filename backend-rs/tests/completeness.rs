//! M4 integration tests: API keys, badges, the status-page read API with
//! its password gate, SPA serving and the OpenAPI document.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::{get_json, harness, request, send};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// Create a monitor through the API and return its id.
async fn create_monitor(h: &common::Harness, body: Value) -> i64 {
    let (status, response) = send(
        &h.app,
        request("POST", "/api/v1/monitors", Some(&h.token), Some(body)),
    )
    .await;
    assert_eq!(status, 201, "create failed: {response}");
    response["monitor"]["id"].as_i64().unwrap()
}

/// Put a monitor on a public status-page group, so badges and pages see it.
async fn make_public(h: &common::Harness, monitor_id: i64) -> i64 {
    let (page_id,): (i64,) = sqlx::query_as(
        "INSERT INTO status_pages (slug, title, published) VALUES ('clients', 'Clients', 1) RETURNING id",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let (group_id,): (i64,) = sqlx::query_as(
        "INSERT INTO status_page_groups (status_page_id, name, weight, public) VALUES (?, 'Hosts', 1, 1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO status_page_monitors (group_id, monitor_id, send_url, weight) VALUES (?, ?, 1, 1)")
        .bind(group_id)
        .bind(monitor_id)
        .execute(&h.pool)
        .await
        .unwrap();
    page_id
}

async fn seed_beat(
    h: &common::Harness,
    monitor_id: i64,
    seconds_ago: i64,
    status: i64,
    ping: Option<f64>,
) {
    let time = (chrono::Utc::now() - chrono::Duration::seconds(seconds_ago))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    sqlx::query("INSERT INTO heartbeats (monitor_id, time, status, ping) VALUES (?, ?, ?, ?)")
        .bind(monitor_id)
        .bind(time)
        .bind(status)
        .bind(ping)
        .execute(&h.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn api_key_list_reports_when_a_key_was_last_used() {
    let h = harness().await;
    let (_, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/api-keys",
            Some(&h.token),
            Some(json!({ "name": "kitchen-tv" })),
        ),
    )
    .await;
    let minted = body["token"].as_str().unwrap().to_string();
    let key_id = body["apiKey"]["id"].as_i64().unwrap();
    assert!(body["apiKey"]["lastUsedAt"].is_null());

    let find = |body: &Value| {
        body["apiKeys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|key| key["id"] == key_id)
            .cloned()
            .unwrap()
    };

    let (_, listed) = get_json(&h.app, "/api/v1/api-keys", &h.token).await;
    assert!(find(&listed)["lastUsedAt"].is_null(), "never used yet");

    let (status, _) = get_json(&h.app, "/api/v1/health", &minted).await;
    assert_eq!(status, 200);

    // The stamp is written off the request path, so give it a moment.
    let mut listed = Value::Null;
    for _ in 0..50 {
        (_, listed) = get_json(&h.app, "/api/v1/api-keys", &h.token).await;
        if find(&listed)["lastUsedAt"].is_string() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        find(&listed)["lastUsedAt"].is_string(),
        "using the key stamps it: {listed}"
    );
}

#[tokio::test]
async fn api_keys_lifecycle_and_auth_effects() {
    let h = harness().await;

    let (status, body) = get_json(&h.app, "/api/v1/api-keys", &h.token).await;
    assert_eq!(status, 200);
    assert_eq!(body["count"], 1, "the admin token is listed");
    assert_eq!(body["availableScopes"][0], "full");
    // The admin token's hash never leaves the server.
    assert!(body["apiKeys"][0].get("hash").is_none());

    // Minting requires a name.
    let (status, _) = send(
        &h.app,
        request("POST", "/api/v1/api-keys", Some(&h.token), Some(json!({}))),
    )
    .await;
    assert_eq!(status, 400);

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/api-keys",
            Some(&h.token),
            Some(json!({ "name": "ci-runner", "scopes": ["read"] })),
        ),
    )
    .await;
    assert_eq!(status, 201);
    let key_id = body["apiKey"]["id"].as_i64().unwrap();
    let minted = body["token"].as_str().unwrap().to_string();
    assert!(minted.starts_with("flatline_"));
    assert_eq!(body["apiKey"]["status"], "active");
    assert_eq!(
        body["apiKey"]["scopes"][0], "full",
        "scopes are ignored: full permission"
    );

    // The minted token authenticates.
    let (status, _) = get_json(&h.app, "/api/v1/health", &minted).await;
    assert_eq!(status, 200);

    // Disabling revokes access immediately.
    let (status, body) = send(
        &h.app,
        request(
            "PATCH",
            &format!("/api/v1/api-keys/{key_id}"),
            Some(&h.token),
            Some(json!({ "active": false })),
        ),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["apiKey"]["status"], "inactive");
    let (status, _) = get_json(&h.app, "/api/v1/health", &minted).await;
    assert_eq!(status, 401);

    // Deleting removes it for good.
    let (status, body) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/api-keys/{key_id}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["deleted"], key_id);
    let (status, _) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/api-keys/{key_id}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, 404);

    // An expired token is refused and reported as expired.
    let past = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/api-keys",
            Some(&h.token),
            Some(json!({ "name": "stale", "expires": past })),
        ),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(body["apiKey"]["status"], "expired");
    let expired_token = body["token"].as_str().unwrap();
    let (status, _) = get_json(&h.app, "/api/v1/health", expired_token).await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn badges_serve_svg_for_public_monitors_only() {
    let h = harness().await;
    let monitor_id = create_monitor(
        &h,
        json!({ "name": "site", "type": "http", "url": "http://example.com" }),
    )
    .await;
    let private_id = create_monitor(
        &h,
        json!({ "name": "private", "type": "http", "url": "http://example.com" }),
    )
    .await;
    make_public(&h, monitor_id).await;

    // Two hours of history: 1h up, 1h down → 50%.
    seed_beat(&h, monitor_id, 7200, 1, Some(40.0)).await;
    seed_beat(&h, monitor_id, 3600, 0, None).await;
    seed_beat(&h, monitor_id, 100, 1, Some(44.0)).await;

    // Status badge.
    let (status, body) = send(
        &h.app,
        request(
            "GET",
            &format!("/api/badge/{monitor_id}/status"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, 200);
    let svg = body.as_str().unwrap_or_default().to_string();
    // `send` parses JSON; SVG comes back as a string only if it is valid
    // JSON — so fetch it raw instead.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/badge/{monitor_id}/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
    let raw = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(raw.contains("aria-label=\"Status: Up\""), "got: {raw}");
    assert!(raw.contains("#66c20a"));
    let _ = (status, body, svg);

    // Uptime badge: 24h default, time-weighted — 1h up, 1h down, then the
    // latest up stretch.
    let raw = raw_get(&h, &format!("/api/badge/{monitor_id}/uptime")).await;
    assert!(raw.contains("Uptime (24h)"));
    assert!(raw.contains("51.39%"), "got: {raw}");

    // Ping badge: average of the non-null pings.
    let raw = raw_get(&h, &format!("/api/badge/{monitor_id}/ping")).await;
    assert!(raw.contains("Avg. Ping (24h)"));
    assert!(raw.contains("42ms"), "got: {raw}");

    // Response badge: latest ping.
    let raw = raw_get(&h, &format!("/api/badge/{monitor_id}/response")).await;
    assert!(raw.contains("Response"));
    assert!(raw.contains("44ms"));

    // Avg-response badge.
    let raw = raw_get(&h, &format!("/api/badge/{monitor_id}/avg-response")).await;
    assert!(raw.contains("Avg. Response (24h)"));

    // A monitor on no public group is N/A.
    let raw = raw_get(&h, &format!("/api/badge/{private_id}/status")).await;
    assert!(raw.contains("N/A"), "got: {raw}");

    // A non-numeric id is a JSON 403, like the Node routes.
    let (status, body) = send(&h.app, request("GET", "/api/badge/abc/status", None, None)).await;
    assert_eq!(status, 403);
    assert_eq!(body["status"], "fail");
}

/// Fetch a badge and return the raw SVG body.
async fn raw_get(h: &common::Harness, uri: &str) -> String {
    let response = h
        .app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "for {uri}");
    String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn status_page_read_api_with_password_gate() {
    let h = harness().await;
    let monitor_id = create_monitor(
        &h,
        json!({ "name": "site", "type": "http", "url": "http://example.com" }),
    )
    .await;
    let page_id = make_public(&h, monitor_id).await;

    sqlx::query(
        "INSERT INTO status_page_cnames (status_page_id, domain) VALUES (?, 'status.clients.kz')",
    )
    .bind(page_id)
    .execute(&h.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO status_page_incidents (status_page_id, style, title, content, pin, active, created_date)
         VALUES (?, 'info', 'Pinned', 'body', 1, 1, '2026-10-01 10:00:00')",
    )
    .bind(page_id)
    .execute(&h.pool)
    .await
    .unwrap();
    seed_beat(&h, monitor_id, 60, 1, Some(12.0)).await;

    // Host resolution, with and without a port, matched and not.
    let (status, body) = get_json(
        &h.app,
        "/api/status-page/resolve-host?host=status.clients.kz:3001",
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["slug"], "clients");
    assert_eq!(body["matched"], true);
    assert_eq!(body["host"], "status.clients.kz");
    let (_, body) = get_json(
        &h.app,
        "/api/status-page/resolve-host?host=nope.kz",
        &h.token,
    )
    .await;
    assert_eq!(body["slug"], Value::Null);
    assert_eq!(body["matched"], false);

    // Page data.
    let (status, body) = get_json(&h.app, "/api/status-page/clients", &h.token).await;
    assert_eq!(status, 200);
    assert_eq!(body["config"]["title"], "Clients");
    assert_eq!(body["config"]["published"], true);
    assert_eq!(body["incidents"][0]["title"], "Pinned");
    assert_eq!(body["publicGroupList"][0]["name"], "Hosts");
    assert_eq!(
        body["publicGroupList"][0]["monitorList"][0]["id"],
        monitor_id
    );
    assert_eq!(
        body["publicGroupList"][0]["monitorList"][0]["sendUrl"],
        true
    );
    assert_eq!(body["maintenanceList"].as_array().unwrap().len(), 0);

    // Heartbeats + uptime.
    let (status, body) = get_json(&h.app, "/api/status-page/heartbeat/clients", &h.token).await;
    assert_eq!(status, 200);
    let beats = body["heartbeatList"][monitor_id.to_string()]
        .as_array()
        .unwrap();
    assert_eq!(beats.len(), 1);
    assert_eq!(beats[0]["status"], 1);
    assert_eq!(beats[0]["msg"], "", "public beats hide the message");
    assert_eq!(body["uptimeList"][format!("{monitor_id}_24")], 1.0);

    // Incident history with cursor pagination (12 incidents, 10 per page).
    for index in 0..12 {
        sqlx::query(
            "INSERT INTO status_page_incidents (status_page_id, title, created_date) VALUES (?, ?, ?)",
        )
        .bind(page_id)
        .bind(format!("incident {index}"))
        .bind(format!("2026-09-{:02} 10:00:00", index + 1))
        .execute(&h.pool)
        .await
        .unwrap();
    }
    let (status, body) = get_json(
        &h.app,
        "/api/status-page/clients/incident-history",
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["total"], 13);
    assert_eq!(body["incidents"].as_array().unwrap().len(), 10);
    assert_eq!(body["hasMore"], true);
    let cursor = body["nextCursor"].as_str().unwrap().to_string();
    let encoded_cursor = cursor.replace(' ', "%20");
    let (status, body) = get_json(
        &h.app,
        &format!("/api/status-page/clients/incident-history?cursor={encoded_cursor}"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["incidents"].as_array().unwrap().len(), 3);
    assert_eq!(body["hasMore"], false);

    // Manifest and robots.
    let (status, body) = get_json(&h.app, "/api/status-page/clients/manifest.json", &h.token).await;
    assert_eq!(status, 200);
    assert_eq!(body["name"], "Clients");
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/robots.txt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let robots = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(robots.contains("Disallow: /"));

    // Password gate: lock the page and check every read is refused.
    let hash = bcrypt::hash("hunter2", 4).unwrap();
    sqlx::query("UPDATE status_pages SET password = ? WHERE id = ?")
        .bind(&hash)
        .bind(page_id)
        .execute(&h.pool)
        .await
        .unwrap();

    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/status-page/clients")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["www-authenticate"], "Form");
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["error"], "password_required");

    // Wrong password: 401 HTML prompt.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/status-pages/unlock/clients")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "password": "wrong" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let prompt = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(prompt.contains("That password is not correct."));

    // Right password: 302 with the signed cookie.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/status-pages/unlock/clients")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "password": "hunter2" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_string();
    assert!(cookie.starts_with("fl_status_auth="));
    assert!(cookie.contains("HttpOnly"));

    // With the cookie, the page reads again.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/status-page/clients")
                .header("cookie", cookie.split(';').next().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Unknown slugs stay 404.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/status-page/nope")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn spa_is_served_with_the_node_routing_contract() {
    let h = harness().await;
    let dist = h._dir.path().join("no-web-build");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(
        dist.join("index.html"),
        "<!doctype html><title>Flatline</title>",
    )
    .unwrap();
    std::fs::write(dist.join("favicon.svg"), "<svg/>").unwrap();
    std::fs::write(dist.join("assets/app-abc123.js"), "console.log(1)").unwrap();

    // The shell at the root and for client-side routes.
    for uri in ["/", "/dashboard", "/status/clients"] {
        let response = h
            .app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "for {uri}");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=0"
        );
        let body = String::from_utf8(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap();
        assert!(body.contains("Flatline"), "for {uri}");
    }

    // Hashed assets are immutable.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/assets/app-abc123.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );

    // Other build files are served as-is.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/favicon.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");

    // API paths keep their JSON 404s; a missing asset is a real 404.
    for uri in ["/api/nope", "/assets/missing.js"] {
        let response = h
            .app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "for {uri}");
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["ok"], false, "for {uri}");
    }

    // Non-GET requests never reach the SPA.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/dashboard")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn openapi_document_describes_the_rust_surface() {
    let h = harness().await;
    let (status, body) = get_json(&h.app, "/api/v1/openapi.json", &h.token).await;
    assert_eq!(status, 200);
    assert_eq!(body["openapi"], "3.1.0");
    let paths = body["paths"].as_object().unwrap();
    assert!(paths.contains_key("/api/v1/monitors"));
    assert!(paths.contains_key("/api/push/{pushToken}"));
    assert!(paths.contains_key("/api/v1/api-keys"));
    assert!(paths.contains_key("/api/v1/users"));
    assert!(!paths.contains_key("/api/v1/maintenance"));
}
