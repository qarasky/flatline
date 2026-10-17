//! Server -> website link contract: raw vs resolved links, group expansion,
//! bulk fetch, replacement semantics and cascade cleanup.

use axum::http::StatusCode;
use serde_json::{Value, json};

mod common;
use common::{Harness, get_json, harness, request, send};

/// Create a monitor of the given type and return its id.
async fn create(h: &Harness, name: &str, kind: &str, extra: Value) -> i64 {
    let mut body = json!({ "name": name, "type": kind });
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

/// PUT a link set and return (status, body).
async fn put_links(h: &Harness, id: i64, ids: Value) -> (StatusCode, Value) {
    send(
        &h.app,
        request(
            "PUT",
            &format!("/api/v1/monitors/{id}/links"),
            Some(&h.token),
            Some(json!({ "linkedMonitorIds": ids })),
        ),
    )
    .await
}

/// GET a single server's links.
async fn get_links(h: &Harness, id: i64) -> (StatusCode, Value) {
    get_json(&h.app, &format!("/api/v1/monitors/{id}/links"), &h.token).await
}

#[tokio::test]
async fn links_are_set_listed_and_cleared() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;
    let web = create(&h, "site", "http", json!({ "url": "https://example.com" })).await;

    let (status, body) = put_links(&h, server, json!([web])).await;
    assert_eq!(status, StatusCode::OK, "put failed: {body}");
    assert_eq!(body["monitorId"], server);
    assert_eq!(body["raw"].as_array().unwrap().len(), 1);
    assert_eq!(body["raw"][0]["linkedMonitorId"], web);
    assert_eq!(body["raw"][0]["type"], "http");
    // No heartbeat yet: pending, matching the SPA's own default.
    assert_eq!(body["raw"][0]["status"], 2);

    assert_eq!(body["resolved"].as_array().unwrap().len(), 1);
    assert_eq!(body["resolved"][0]["id"], web);
    assert_eq!(body["resolved"][0]["via"], web);

    // GET agrees with PUT.
    let (status, body) = get_links(&h, server).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["resolved"][0]["name"], "site");

    // DELETE clears.
    let (status, body) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{server}/links"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["raw"], json!([]));
    assert_eq!(body["resolved"], json!([]));
}

#[tokio::test]
async fn replacing_links_is_exact() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;
    let a = create(&h, "a", "http", json!({ "url": "https://a.example" })).await;
    let b = create(&h, "b", "http", json!({ "url": "https://b.example" })).await;

    put_links(&h, server, json!([a, b])).await;
    // Replacing with a single id drops the other.
    let (_, body) = put_links(&h, server, json!([b])).await;
    assert_eq!(body["raw"].as_array().unwrap().len(), 1);
    assert_eq!(body["raw"][0]["linkedMonitorId"], b);
}

#[tokio::test]
async fn group_links_expand_to_descendants_including_later_ones() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;
    let group = create(&h, "clients", "group", json!({})).await;
    let one = create(&h, "one", "http", json!({ "url": "https://one.example", "parent": group })).await;

    let (_, body) = put_links(&h, server, json!([group])).await;
    assert_eq!(body["raw"].as_array().unwrap().len(), 1);
    assert_eq!(body["raw"][0]["type"], "group");
    assert_eq!(body["resolved"].as_array().unwrap().len(), 1);
    assert_eq!(body["resolved"][0]["id"], one);
    assert_eq!(body["resolved"][0]["via"], group, "attributed to the group link");

    // A website added to the group afterwards appears without re-linking.
    let two = create(&h, "two", "http", json!({ "url": "https://two.example", "parent": group })).await;
    let (_, body) = get_links(&h, server).await;
    let ids: Vec<i64> = body["resolved"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![one, two]);
}

#[tokio::test]
async fn replace_drops_self_duplicates_and_unknown_ids() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;
    let web = create(&h, "site", "http", json!({ "url": "https://example.com" })).await;

    let (status, body) = put_links(&h, server, json!([server, web, web, 999999])).await;
    assert_eq!(status, StatusCode::OK);
    let raw = body["raw"].as_array().unwrap();
    assert_eq!(raw.len(), 1, "self, duplicate and unknown ids are dropped");
    assert_eq!(raw[0]["linkedMonitorId"], web);
}

#[tokio::test]
async fn bulk_returns_links_keyed_by_server() {
    let h = harness().await;
    let s1 = create(&h, "s1", "push", json!({})).await;
    let s2 = create(&h, "s2", "push", json!({})).await;
    let lazy = create(&h, "lazy", "push", json!({})).await;
    let web = create(&h, "site", "http", json!({ "url": "https://example.com" })).await;

    put_links(&h, s1, json!([web])).await;
    put_links(&h, s2, json!([web])).await;

    let (status, body) = get_json(
        &h.app,
        &format!("/api/v1/monitors/links?ids={s1},{s2},{lazy}"),
        &h.token,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 2, "servers without links are omitted");
    assert_eq!(body["servers"][s1.to_string()]["resolved"][0]["id"], web);
    assert_eq!(body["servers"][s2.to_string()]["raw"][0]["name"], "site");
    assert!(body["servers"].get(lazy.to_string()).is_none());
}

#[tokio::test]
async fn links_validate_input() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;

    let (status, body) = put_links(&h, server, json!("nope")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "bad_request");

    let (status, _) = put_links(&h, server, json!([0])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = get_json(&h.app, "/api/v1/monitors/links?ids=", &h.token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A server that does not exist is a 404, not a silent success.
    let (status, _) = get_links(&h, 999999).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_a_monitor_cascades_its_links() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;
    let web = create(&h, "site", "http", json!({ "url": "https://example.com" })).await;
    put_links(&h, server, json!([web])).await;

    // Deleting the target removes the link from the server.
    send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{web}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    let (_, body) = get_links(&h, server).await;
    assert_eq!(body["raw"], json!([]), "target deletion cascades");

    // Deleting the server removes its links too.
    let web2 = create(&h, "site-2", "http", json!({ "url": "https://two.example" })).await;
    put_links(&h, server, json!([web2])).await;
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM monitor_links")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(before, 1);

    send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{server}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM monitor_links")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "server deletion cascades");
}

#[tokio::test]
async fn only_websites_are_linkable() {
    let h = harness().await;
    let server = create(&h, "host", "push", json!({})).await;
    let other = create(&h, "other-host", "push", json!({})).await;
    let ping = create(&h, "ping", "ping", json!({ "hostname": "1.1.1.1" })).await;
    let web = create(&h, "site", "http", json!({ "url": "https://example.com" })).await;
    let group = create(&h, "clients", "group", json!({})).await;
    let grouped_web = create(
        &h,
        "grouped-site",
        "http",
        json!({ "url": "https://grouped.example", "parent": group }),
    )
    .await;
    let grouped_server = create(&h, "grouped-host", "push", json!({ "parent": group })).await;

    // A direct link to another server or to a ping check is refused instead
    // of being stored and drawn as a website chip.
    let (status, body) = put_links(&h, server, json!([other, ping, web])).await;
    assert_eq!(status, StatusCode::OK, "put failed: {body}");
    let raw = body["raw"].as_array().unwrap();
    assert_eq!(raw.len(), 1, "only the website survives: {body}");
    assert_eq!(raw[0]["linkedMonitorId"], web);

    // A group link expands to the websites inside it, skipping the servers.
    let (_, body) = put_links(&h, server, json!([group])).await;
    assert_eq!(body["raw"][0]["type"], "group");
    let ids: Vec<i64> = body["resolved"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![grouped_web]);
    assert!(
        !ids.contains(&grouped_server),
        "servers inside a group are not websites"
    );
}
