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
async fn malformed_agent_version_is_rejected() {
    let h = harness().await;
    let (_, token) = register(&h, "meks").await;
    let (status, body) = start(&h, &token, json!({"agentVersion": "latest"})).await;
    assert_eq!(status, 400, "{body}");
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
