//! Provisioning surfaces: the tokenized runbook, installer script, agent
//! downloads and version endpoint.

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

mod common;
use common::harness;

/// GET with an explicit Host header (so origin rendering is deterministic)
/// and an optional bearer token; returns status, headers and raw bytes.
async fn get_raw(
    app: &Router,
    uri: &str,
    bearer: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder()
        .method("GET")
        .uri(uri)
        .header("host", "test.example");
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string()
}

#[tokio::test]
async fn provisioning_endpoints_require_a_valid_token() {
    let h = harness().await;

    for uri in [
        "/add-push-server.md",
        "/llms.txt",
        "/agent/install.sh",
        "/agent/sha256sums",
        "/agent/superboard-linux-amd64",
        "/agent/version",
    ] {
        let (status, _, _) = get_raw(&h.app, uri, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} must be gated");

        let (status, _, _) = get_raw(&h.app, &format!("{uri}?token=flatline_wrong"), None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{uri} must reject bad tokens"
        );
    }
}

#[tokio::test]
async fn runbook_renders_origin_token_and_version() {
    let h = harness().await;
    std::fs::create_dir_all(&h.state.config.agent_dir).unwrap();
    std::fs::write(h.state.config.agent_dir.join("VERSION"), "9.9.9\n").unwrap();

    let (status, headers, bytes) = get_raw(
        &h.app,
        &format!("/add-push-server.md?token={}", h.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header(&headers, "content-type"),
        "text/markdown; charset=utf-8"
    );
    assert_eq!(header(&headers, "cache-control"), "no-store");

    let body = String::from_utf8(bytes).unwrap();
    assert!(body.contains("https://test.example"), "origin must render");
    assert!(body.contains(&h.token), "token must render");
    assert!(body.contains("9.9.9"), "agent version must render");
    assert!(!body.contains("{{"), "no placeholders may survive: {body}");
    assert!(
        body.contains("-X POST \"https://test.example/api/v1/monitors\""),
        "runbook must carry the create call"
    );
}

#[tokio::test]
async fn installer_is_pre_credentialed_and_header_auth_works() {
    let h = harness().await;

    // Bearer instead of the query parameter: both are accepted.
    let (status, headers, bytes) = get_raw(&h.app, "/agent/install.sh", Some(&h.token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header(&headers, "content-type"),
        "text/x-shellscript; charset=utf-8"
    );

    let body = String::from_utf8(bytes).unwrap();
    assert!(
        body.contains(&h.token),
        "download credential must be embedded"
    );
    assert!(body.contains("https://test.example"), "origin must render");
    assert!(body.contains("--update"), "update path must exist");
    assert!(!body.contains("{{"), "no placeholders may survive");
}

#[tokio::test]
async fn llms_points_at_the_tokenized_runbook() {
    let h = harness().await;
    let (status, _, bytes) = get_raw(&h.app, &format!("/llms.txt?token={}", h.token), None).await;
    assert_eq!(status, StatusCode::OK);

    let body = String::from_utf8(bytes).unwrap();
    assert!(body.contains(&format!("/add-push-server.md?token={}", h.token)));
    assert!(body.contains("/api/v1/openapi.json"));
}

#[tokio::test]
async fn agent_downloads_checksums_and_version() {
    let h = harness().await;
    let dir = h.state.config.agent_dir.clone();
    std::fs::create_dir_all(&dir).unwrap();

    let binary = b"fake superboard binary".to_vec();
    std::fs::write(dir.join("superboard-linux-amd64"), &binary).unwrap();
    std::fs::write(dir.join("VERSION"), "1.5.0\n").unwrap();
    let digest = hex::encode(Sha256::digest(&binary));
    std::fs::write(
        dir.join("sha256sums"),
        format!("{digest}  superboard-linux-amd64\n"),
    )
    .unwrap();

    let (status, headers, bytes) = get_raw(
        &h.app,
        &format!("/agent/superboard-linux-amd64?token={}", h.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&headers, "content-type"), "application/octet-stream");
    assert_eq!(bytes, binary);
    assert_eq!(header(&headers, "etag"), format!("\"{digest}\""));

    let (status, _, bytes) = get_raw(
        &h.app,
        &format!("/agent/sha256sums?token={}", h.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8(bytes).unwrap().contains(&digest));

    let (status, _, bytes) =
        get_raw(&h.app, &format!("/agent/version?token={}", h.token), None).await;
    assert_eq!(status, StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], "1.5.0");
    assert_eq!(body["agents"][0]["platform"], "linux-amd64");
    assert_eq!(body["agents"][0]["sha256"], digest);
    assert_eq!(body["agents"][0]["size"], binary.len());
    assert_eq!(
        body["agents"][0]["url"],
        "https://test.example/agent/superboard-linux-amd64"
    );
    // The arm64 build is not in this image: no entry, not an error.
    assert_eq!(body["agents"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn missing_agent_builds_answer_404() {
    let h = harness().await;
    let (status, _, _) = get_raw(
        &h.app,
        &format!("/agent/superboard-linux-amd64?token={}", h.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runbook_names_the_host_monitor_for_push_agent_tokens() {
    let h = harness().await;
    std::fs::create_dir_all(&h.state.config.agent_dir).unwrap();
    std::fs::write(h.state.config.agent_dir.join("VERSION"), "9.9.9\n").unwrap();

    let push = flatline_backend::auth::mint_push_token();
    sqlx::query("INSERT INTO monitors (name, type, push_token) VALUES ('edge-01', 'push', ?)")
        .bind(&push)
        .execute(&h.pool)
        .await
        .unwrap();

    let (status, _, bytes) =
        get_raw(&h.app, &format!("/add-push-server.md?token={push}"), None).await;
    assert_eq!(status, StatusCode::OK);
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        body.contains("`push_agent`"),
        "the runbook must state the credential kind: {body}"
    );
    assert!(body.contains("edge-01"), "monitor name must render");
    assert!(
        body.contains("**Host push monitor**: 1 (`edge-01`)"),
        "the monitor id and name must render"
    );
    assert!(!body.contains("{{"), "no placeholders may survive");

    // The same token cannot touch the operator API.
    let (status, _, _) = get_raw(&h.app, "/api/v1/monitors", Some(&push)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
