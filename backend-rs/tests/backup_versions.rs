//! Backup-agent version reporting and the self-update feed.

mod common;

use std::io;
use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use common::{harness_with_backups, request, send};
use flatline_backend::backups::storage::{FreeSpace, NoFaults, RESERVE_BYTES};
use serde_json::{Value, json};

struct PlentyOfSpace;

impl FreeSpace for PlentyOfSpace {
    fn available(&self, _root: &Path) -> io::Result<u64> {
        Ok(RESERVE_BYTES + 256 * 1024 * 1024)
    }
}

async fn harness() -> common::Harness {
    harness_with_backups(Arc::new(PlentyOfSpace), Arc::new(NoFaults)).await
}

async fn register(h: &common::Harness, name: &str) -> (String, String) {
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/backup-agents",
            Some(&h.token),
            Some(json!({ "name": name })),
        ),
    )
    .await;
    assert_eq!(status, 201, "register {name}: {body}");
    (
        body["agent"]["id"].as_str().unwrap().to_string(),
        body["token"].as_str().unwrap().to_string(),
    )
}

async fn start(h: &common::Harness, token: &str, extra: Value) -> (StatusCode, Value) {
    let mut body = json!({
        "clientRunId": "r1",
        "exportStartedAt": "2026-01-01T00:00:00Z",
        "exportFinishedAt": "2026-01-01T01:00:00Z",
        "totalBytes": 10,
        "sha256": "a".repeat(64),
        "sourceSummary": {"databaseCount": 1, "objectCount": 0, "sourceBytes": 10, "encrypted": false},
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    send(
        &h.app,
        request("POST", "/api/backup/v1/runs", Some(token), Some(body)),
    )
    .await
}

async fn agent(h: &common::Harness, id: &str) -> Value {
    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/backup-agents", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == id)
        .cloned()
        .expect("agent is listed")
}

#[tokio::test]
async fn run_start_records_agent_version() {
    let h = harness().await;
    let (id, token) = register(&h, "meks").await;
    let (status, body) = start(&h, &token, json!({"agentVersion": "0.3.0"})).await;
    assert_eq!(status, 200, "{body}");

    let listed = agent(&h, &id).await;
    assert_eq!(listed["reportedVersion"], "0.3.0");
    assert!(listed["versionReportedAt"].is_string(), "{listed}");
}

#[tokio::test]
async fn retry_with_new_version_is_the_same_run() {
    let h = harness().await;
    let (_, token) = register(&h, "meks").await;
    let (status, first) = start(&h, &token, json!({})).await;
    assert_eq!(status, 200, "{first}");
    // The pending bundle a 0.2.0 agent wrote, retried after the upgrade:
    // the new version field must not make it a different run.
    let (status, retried) = start(&h, &token, json!({"agentVersion": "0.3.0"})).await;
    assert_eq!(status, 200, "{retried}");
    assert_eq!(first["run"]["id"], retried["run"]["id"]);
}

#[tokio::test]
async fn malformed_agent_version_never_blocks_a_backup() {
    let h = harness().await;
    let (id, token) = register(&h, "meks").await;
    // Metadata must not refuse a backup: the run starts, the bad version is
    // simply not recorded.
    let (status, body) = start(&h, &token, json!({"agentVersion": "latest"})).await;
    assert_eq!(status, 200, "{body}");
    assert!(agent(&h, &id).await["reportedVersion"].is_null());
}

#[tokio::test]
async fn full_semver_versions_are_accepted() {
    let h = harness().await;
    let (id, token) = register(&h, "meks").await;
    let (status, body) = start(&h, &token, json!({"agentVersion": "1.2.3-rc.1+build.5"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(agent(&h, &id).await["reportedVersion"], "1.2.3-rc.1+build.5");
}

#[tokio::test]
async fn agents_without_reports_have_null_version() {
    let h = harness().await;
    let (id, _) = register(&h, "meks").await;
    let listed = agent(&h, &id).await;
    assert!(listed["reportedVersion"].is_null(), "{listed}");
    assert!(listed["updateStatus"].is_null(), "{listed}");
    assert!(
        listed.as_object().unwrap().contains_key("reportedVersion"),
        "the key is present even before a report: {listed}"
    );
}

const RELEASE_BYTES: &[u8] = b"pretend this is a linux-amd64 backup agent build";

/// Ship a release the way the image does: binaries plus VERSION-BACKUP.
fn ship_release(h: &common::Harness) -> std::path::PathBuf {
    let dir = h.state.config.backup_agent_dir.clone();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("VERSION-BACKUP"), "0.3.0\n").unwrap();
    std::fs::write(dir.join("flatline-backup-linux-amd64"), RELEASE_BYTES).unwrap();
    std::fs::write(dir.join("sha256sums-backup"), "not an agent build").unwrap();
    dir
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

async fn checkin(h: &common::Harness, token: &str, body: Value) -> (StatusCode, Value) {
    send(
        &h.app,
        request("POST", "/api/backup/v1/checkin", Some(token), Some(body)),
    )
    .await
}

async fn get_bytes(h: &common::Harness, uri: &str, token: &str) -> (StatusCode, Vec<u8>) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let response = h
        .app
        .clone()
        .oneshot(request("GET", uri, Some(token), None))
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, body.to_vec())
}

#[tokio::test]
async fn checkin_records_version_and_returns_release() {
    let h = harness().await;
    ship_release(&h);
    let (id, token) = register(&h, "meks").await;
    let (status, body) = checkin(
        &h,
        &token,
        json!({"version": "0.2.0", "platform": "linux-amd64", "updateStatus": "ok"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["release"]["version"], "0.3.0");
    let assets = body["release"]["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 1, "only backup-agent builds are assets: {body}");
    assert_eq!(assets[0]["platform"], "linux-amd64");
    assert_eq!(assets[0]["file"], "flatline-backup-linux-amd64");
    assert_eq!(assets[0]["size"], RELEASE_BYTES.len());
    assert_eq!(assets[0]["sha256"], sha256_hex(RELEASE_BYTES));

    let listed = agent(&h, &id).await;
    assert_eq!(listed["reportedVersion"], "0.2.0");
    assert_eq!(listed["updateStatus"], "ok");
}

#[tokio::test]
async fn checkin_without_status_keeps_the_stored_one() {
    let h = harness().await;
    let (id, token) = register(&h, "meks").await;
    let (status, _) = checkin(
        &h,
        &token,
        json!({"version": "0.2.0", "platform": "linux-amd64", "updateStatus": "lock_timeout"}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = checkin(
        &h,
        &token,
        json!({"version": "0.2.0", "platform": "linux-amd64", "updateStatus": null}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(agent(&h, &id).await["updateStatus"], "lock_timeout");
}

#[tokio::test]
async fn checkin_rejects_malformed_fields() {
    let h = harness().await;
    let (_, token) = register(&h, "meks").await;
    for body in [
        json!({"version": "latest", "platform": "linux-amd64"}),
        json!({"version": "0.2.0", "platform": "linux-amd64", "updateStatus": "Bad Status!"}),
    ] {
        let (status, response) = checkin(&h, &token, body).await;
        assert_eq!(status, 400, "{response}");
    }
}

#[tokio::test]
async fn release_download_streams_exact_bytes() {
    let h = harness().await;
    ship_release(&h);
    let (_, token) = register(&h, "meks").await;
    let (status, bytes) = get_bytes(
        &h,
        "/api/backup/v1/release/flatline-backup-linux-amd64",
        &token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(bytes, RELEASE_BYTES);
}

#[tokio::test]
async fn release_routes_refuse_other_credentials() {
    let h = harness().await;
    ship_release(&h);
    let body = json!({"version": "0.2.0", "platform": "linux-amd64"});
    // The operator token is not a backup credential.
    let (status, _) = checkin(&h, &h.token, body.clone()).await;
    assert_eq!(status, 401);
    let (status, _) = get_bytes(
        &h,
        "/api/backup/v1/release/flatline-backup-linux-amd64",
        &h.token,
    )
    .await;
    assert_eq!(status, 401);
    // No credential at all.
    let (status, _) = send(
        &h.app,
        request("POST", "/api/backup/v1/checkin", None, Some(body)),
    )
    .await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn release_rejects_foreign_file_names() {
    let h = harness().await;
    let dir = ship_release(&h);
    std::fs::write(dir.join("superboard-linux-amd64"), b"telemetry agent").unwrap();
    let (_, token) = register(&h, "meks").await;
    for file in [
        "superboard-linux-amd64",
        "VERSION-BACKUP",
        "sha256sums-backup",
        "flatline-backup-",
        "..%2Fflatline.db",
        "flatline-backup-linux-amd64%2F..",
    ] {
        let (status, _) = get_bytes(&h, &format!("/api/backup/v1/release/{file}"), &token).await;
        assert_eq!(status, 404, "{file} must not be served");
    }
}

#[tokio::test]
async fn missing_release_dir_reports_null_version() {
    let h = harness().await;
    let (_, token) = register(&h, "meks").await;
    let (status, body) = checkin(
        &h,
        &token,
        json!({"version": "0.2.0", "platform": "linux-amd64"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["release"]["version"].is_null(), "{body}");
    assert_eq!(body["release"]["assets"], json!([]));
}

#[tokio::test]
async fn agent_feed_still_refuses_backup_tokens() {
    let h = harness().await;
    let (_, token) = register(&h, "meks").await;
    let (status, _) = send(
        &h.app,
        request("GET", &format!("/agent/version?token={token}"), None, None),
    )
    .await;
    assert!(
        status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN,
        "backup tokens stay off the telemetry feed, got {status}"
    );
}
