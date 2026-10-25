//! Durable resumable uploads: chunk contracts, capacity and crash recovery.

mod common;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{harness, harness_with_backups, request, send};
use flatline_backend::backups::storage::{
    CHUNK_BYTES, FaultInjector, FaultPoint, FreeSpace, RESERVE_BYTES, STORAGE_MARKER,
};
use flatline_backend::backups::{Backups, StartRun};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

struct FakeFreeSpace(AtomicU64);

impl FakeFreeSpace {
    fn new(bytes: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(bytes)))
    }
}

impl FreeSpace for FakeFreeSpace {
    fn available(&self, _root: &Path) -> io::Result<u64> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

#[derive(Default)]
struct ScriptedFaults {
    next: Mutex<Option<FaultPoint>>,
}

impl ScriptedFaults {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn arm(&self, point: FaultPoint) {
        *self.next.lock().unwrap() = Some(point);
    }
}

impl FaultInjector for ScriptedFaults {
    fn hit(&self, point: FaultPoint) -> io::Result<()> {
        let mut next = self.next.lock().unwrap();
        if *next == Some(point) {
            *next = None;
            return Err(io::Error::other("injected storage fault"));
        }
        Ok(())
    }
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn register(h: &common::Harness, name: &str) -> (String, String) {
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/backup-agents",
            Some(&h.token),
            Some(json!({
                "name": name,
                "monitorId": null,
                "enabled": true,
                "intervalSeconds": 86400,
                "retentionCount": 7,
            })),
        ),
    )
    .await;
    assert_eq!(status, 201, "register {name}: {body}");
    (
        body["agent"]["id"].as_str().unwrap().to_string(),
        body["token"].as_str().unwrap().to_string(),
    )
}

async fn start_run(
    h: &common::Harness,
    token: &str,
    client_run_id: &str,
    total: u64,
    sha256: &str,
) -> (StatusCode, Value) {
    let summary = json!({"databaseCount": 1, "objectCount": 0, "sourceBytes": total});
    start_run_with_summary(h, token, client_run_id, total, sha256, summary).await
}

async fn start_run_with_summary(
    h: &common::Harness,
    token: &str,
    client_run_id: &str,
    total: u64,
    sha256: &str,
    summary: Value,
) -> (StatusCode, Value) {
    // Fixed times: a retry of the same clientRunId must carry the original
    // manifest times, exactly as the Go agent's pending descriptor does.
    send(
        &h.app,
        request(
            "POST",
            "/api/backup/v1/runs",
            Some(token),
            Some(json!({
                "clientRunId": client_run_id,
                "exportStartedAt": "2026-01-01T00:00:00Z",
                "exportFinishedAt": "2026-01-01T01:00:00Z",
                "totalBytes": total,
                "sha256": sha256,
                "sourceSummary": summary,
            })),
        ),
    )
    .await
}

async fn put_raw(
    h: &common::Harness,
    token: &str,
    run_id: &str,
    index: u64,
    offset: u64,
    sha256: &str,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("PUT")
        .uri(format!("/api/backup/v1/runs/{run_id}/chunks/{index}"))
        .header("authorization", format!("Bearer {token}"))
        .header("x-backup-offset", offset.to_string())
        .header("x-backup-sha256", sha256)
        .body(Body::from(body))
        .unwrap();
    send(&h.app, request).await
}

async fn put(
    h: &common::Harness,
    token: &str,
    run_id: &str,
    index: u64,
    offset: u64,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let sha = digest(&body);
    put_raw(h, token, run_id, index, offset, &sha, body).await
}

async fn complete(h: &common::Harness, token: &str, run_id: &str) -> (StatusCode, Value) {
    send(
        &h.app,
        request(
            "POST",
            &format!("/api/backup/v1/runs/{run_id}/complete"),
            Some(token),
            None,
        ),
    )
    .await
}

fn run_path(h: &common::Harness, agent_id: &str, run_id: &str, name: &str) -> PathBuf {
    h.backup_root
        .as_ref()
        .unwrap()
        .join("agents")
        .join(agent_id)
        .join(run_id)
        .join(name)
}

#[tokio::test]
async fn chunks_retry_resume_and_isolate() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let faults = ScriptedFaults::new();
    let h = harness_with_backups(free, faults).await;
    let (meks_id, meks_token) = register(&h, "meks").await;
    let (_, zhkh_token) = register(&h, "zhkhteam").await;

    let mut data = vec![0u8; CHUNK_BYTES as usize + 1024];
    for (index, byte) in data.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    let total = data.len() as u64;
    let (status, started) = start_run(&h, &meks_token, "chunked-run", total, &digest(&data)).await;
    assert_eq!(status, 200, "start failed: {started}");
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    assert_eq!(started["run"]["status"], "uploading");
    assert_eq!(started["offset"], 0);

    // A full 8 MiB chunk, then an identical retry.
    let (status, first) = put(
        &h,
        &meks_token,
        &run_id,
        0,
        0,
        data[..CHUNK_BYTES as usize].to_vec(),
    )
    .await;
    assert_eq!(status, 200, "first chunk failed: {first}");
    assert_eq!(first["offset"], CHUNK_BYTES);

    let (status, retried) = put(
        &h,
        &meks_token,
        &run_id,
        0,
        0,
        data[..CHUNK_BYTES as usize].to_vec(),
    )
    .await;
    assert_eq!(status, 200, "identical retry must succeed: {retried}");
    assert_eq!(retried["offset"], CHUNK_BYTES);

    // Conflicting bytes for the committed index are rejected.
    let (status, conflict) = put(
        &h,
        &meks_token,
        &run_id,
        0,
        0,
        vec![0xAA; CHUNK_BYTES as usize],
    )
    .await;
    assert_eq!(status, 409, "conflicting retry: {conflict}");

    // Index is derived from the offset.
    let (status, wrong_index) = put(
        &h,
        &meks_token,
        &run_id,
        2,
        CHUNK_BYTES,
        data[CHUNK_BYTES as usize..].to_vec(),
    )
    .await;
    assert_eq!(status, 400, "wrong index: {wrong_index}");

    // Another agent sees neither the run nor its bytes.
    let probe = format!("/api/backup/v1/runs/{run_id}");
    let (status, _) = common::get_json(&h.app, &probe, &zhkh_token).await;
    assert_eq!(status, 404);
    let (status, _) = put(
        &h,
        &zhkh_token,
        &run_id,
        0,
        0,
        vec![9u8; CHUNK_BYTES as usize],
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = complete(&h, &zhkh_token, &run_id).await;
    assert_eq!(status, 404);

    // Short non-final chunks are refused.
    let (status, short) = put(&h, &zhkh_token, "not-a-run", 0, 0, vec![1; 1024]).await;
    assert_eq!(status, 404, "unknown run: {short}");

    let (status, final_chunk) = put(
        &h,
        &meks_token,
        &run_id,
        1,
        CHUNK_BYTES,
        data[CHUNK_BYTES as usize..].to_vec(),
    )
    .await;
    assert_eq!(status, 200, "final chunk failed: {final_chunk}");
    assert_eq!(final_chunk["offset"], total);

    let (status, completed) = complete(&h, &meks_token, &run_id).await;
    assert_eq!(status, 200, "complete failed: {completed}");
    assert_eq!(completed["run"]["status"], "completed");
    assert!(completed["run"]["completedAt"].is_string());

    // Completion is idempotent; new chunks are not accepted afterwards.
    let (status, again) = complete(&h, &meks_token, &run_id).await;
    assert_eq!(status, 200, "idempotent completion: {again}");
    assert_eq!(again["run"]["status"], "completed");
    let (status, _) = put(&h, &meks_token, &run_id, 1, total, vec![1]).await;
    assert_eq!(status, 409);

    let published = std::fs::read(run_path(&h, &meks_id, &run_id, "bundle.age")).unwrap();
    assert_eq!(published, data, "published bundle is byte-identical");
    assert!(
        !run_path(&h, &meks_id, &run_id, "bundle.partial").exists(),
        "the partial file is renamed away"
    );
}

#[tokio::test]
async fn hash_and_size_failures_never_complete() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, token) = register(&h, "meks").await;
    let (_, other_token) = register(&h, "zhkhteam").await;

    let data = vec![3u8; 2048];
    let (status, started) = start_run(
        &h,
        &token,
        "digest-run",
        2048,
        &digest(b"a different archive"),
    )
    .await;
    assert_eq!(status, 200);
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    // A body whose digest disagrees with the header is refused before append.
    let (status, mismatch) =
        put_raw(&h, &token, &run_id, 0, 0, &digest(b"other"), data.clone()).await;
    assert_eq!(status, 422, "chunk hash mismatch: {mismatch}");
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["receivedBytes"], 0);
    // A full digest mismatch fails finalization and the run.
    let (status, uploaded) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200, "upload: {uploaded}");
    let (status, failed) = complete(&h, &token, &run_id).await;
    assert_eq!(status, 422, "declared digest wins: {failed}");
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["status"], "failed");
    assert_eq!(probe["run"]["errorCode"], "bundle_hash_mismatch");

    // Early completion is refused while bytes are missing.
    let (status, early) = start_run(&h, &token, "early-run", 4096, &digest(&vec![4u8; 2048])).await;
    assert_eq!(
        status, 200,
        "second run starts after the failed one: {early}"
    );
    let early_id = early["run"]["id"].as_str().unwrap().to_string();
    let (status, refused) = complete(&h, &token, &early_id).await;
    assert_eq!(status, 409, "early completion: {refused}");

    // A short non-final chunk violates the 8 MiB boundary.
    let (status, short) = put(&h, &token, &early_id, 0, 0, vec![4u8; 2048]).await;
    assert_eq!(status, 400, "short non-final chunk: {short}");

    // Oversized bodies are cut off even without a Content-Length header.
    let oversized = vec![5u8; CHUNK_BYTES as usize + 1];
    let (status, huge) = start_run(
        &h,
        &other_token,
        "oversized-run",
        oversized.len() as u64,
        &digest(&oversized),
    )
    .await;
    assert_eq!(status, 200, "oversized run start: {huge}");
    let huge_id = huge["run"]["id"].as_str().unwrap().to_string();
    let (status, rejected) = put(&h, &other_token, &huge_id, 0, 0, oversized).await;
    assert_eq!(status, 413, "oversized body: {rejected}");
    let (_, probe) = common::get_json(
        &h.app,
        &format!("/api/backup/v1/runs/{huge_id}"),
        &other_token,
    )
    .await;
    assert_eq!(probe["run"]["receivedBytes"], 0);
}

#[tokio::test]
async fn restart_recovers_committed_offset() {
    // Crash after append but before fsync: the uncommitted tail is dropped.
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let faults = ScriptedFaults::new();
    let h = harness_with_backups(free, Arc::clone(&faults) as Arc<dyn FaultInjector>).await;
    let (agent_id, token) = register(&h, "meks").await;
    let data = vec![7u8; 4096];

    let (status, started) = start_run(&h, &token, "after-append", 4096, &digest(&data)).await;
    assert_eq!(status, 200);
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    faults.arm(FaultPoint::AfterAppend);
    let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 500, "injected crash surfaces as a server error");

    h.state.backups.reconcile_storage().await.unwrap();
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["receivedBytes"], 0);
    assert_eq!(
        std::fs::metadata(run_path(&h, &agent_id, &run_id, "bundle.partial"))
            .unwrap()
            .len(),
        0,
        "uncommitted tail is truncated"
    );

    let (status, resumed) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200, "resume after reconciliation: {resumed}");

    // Crash after fsync but before the ledger: durable bytes are still
    // discarded because no committed offset covers them.
    let faults = ScriptedFaults::new();
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, Arc::clone(&faults) as Arc<dyn FaultInjector>).await;
    let (agent_id, token) = register(&h, "meks").await;
    let (status, started) = start_run(&h, &token, "after-fsync", 4096, &digest(&data)).await;
    assert_eq!(status, 200);
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    faults.arm(FaultPoint::AfterFsync);
    let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 500);
    h.state.backups.reconcile_storage().await.unwrap();
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["receivedBytes"], 0);
    assert_eq!(
        std::fs::metadata(run_path(&h, &agent_id, &run_id, "bundle.partial"))
            .unwrap()
            .len(),
        0
    );

    // Crash after the ledger commit but before the response: the retry is
    // idempotent and reports the committed offset.
    let faults = ScriptedFaults::new();
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, Arc::clone(&faults) as Arc<dyn FaultInjector>).await;
    let (_agent_id, token) = register(&h, "meks").await;
    let (status, started) = start_run(&h, &token, "after-db", 4096, &digest(&data)).await;
    assert_eq!(status, 200);
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    faults.arm(FaultPoint::AfterDbUpdate);
    let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 500);
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["receivedBytes"], 4096);

    // A fresh service over the same database and storage is the restart.
    let restarted = Backups::with_io(
        h.pool.clone(),
        Arc::clone(&h.state.config),
        Arc::clone(&h.state.events),
        FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024),
        ScriptedFaults::new(),
    );
    restarted.reconcile_storage().await.unwrap();
    let (status, retried) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200, "retry after lost response: {retried}");
    assert_eq!(retried["offset"], 4096);

    // Crash after publication but before completion: boot reconciliation
    // promotes the already-validated file.
    let faults = ScriptedFaults::new();
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, Arc::clone(&faults) as Arc<dyn FaultInjector>).await;
    let (agent_id, token) = register(&h, "meks").await;
    let (status, started) = start_run(&h, &token, "after-rename", 4096, &digest(&data)).await;
    assert_eq!(status, 200);
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let (status, uploaded) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200, "upload: {uploaded}");

    faults.arm(FaultPoint::AfterRename);
    let (status, _) = complete(&h, &token, &run_id).await;
    assert_eq!(status, 500);
    assert!(run_path(&h, &agent_id, &run_id, "bundle.age").exists());

    let restarted = Backups::with_io(
        h.pool.clone(),
        Arc::clone(&h.state.config),
        Arc::clone(&h.state.events),
        FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024),
        ScriptedFaults::new(),
    );
    restarted.reconcile_storage().await.unwrap();
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["status"], "completed");
    assert_eq!(probe["run"]["receivedBytes"], 4096);

    // The same retry works without a boot: complete sees the published file.
    let faults = ScriptedFaults::new();
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, Arc::clone(&faults) as Arc<dyn FaultInjector>).await;
    let (_, token) = register(&h, "meks").await;
    let (status, started) = start_run(&h, &token, "retry-complete", 4096, &digest(&data)).await;
    assert_eq!(status, 200);
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200);
    faults.arm(FaultPoint::AfterRename);
    let (status, _) = complete(&h, &token, &run_id).await;
    assert_eq!(status, 500);
    let (status, retried) = complete(&h, &token, &run_id).await;
    assert_eq!(
        status, 200,
        "lost completion response is retryable: {retried}"
    );
    assert_eq!(retried["run"]["status"], "completed");
}

#[tokio::test]
async fn concurrent_reservations_keep_100_gib_free() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 8 * 1024 * 1024);
    let h = harness_with_backups(
        Arc::clone(&free) as Arc<dyn FreeSpace>,
        ScriptedFaults::new(),
    )
    .await;
    let (_, meks) = register(&h, "meks").await;
    let (_, zhkh) = register(&h, "zhkhteam").await;

    let data = vec![1u8; 8 * 1024 * 1024];
    let data_sha = digest(&data);
    let total = data.len() as u64;
    let (first, second) = tokio::join!(
        start_run(&h, &meks, "race-meks", total, &data_sha),
        start_run(&h, &zhkh, "race-zhkh", total, &data_sha),
    );

    let statuses = [first.0, second.0];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1,
        "only one agent may reserve the last bundle: {first:?} {second:?}"
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::INSUFFICIENT_STORAGE)
            .count(),
        1,
        "the loser gets 507: {first:?} {second:?}"
    );

    // An identical retry does not reserve twice.
    let winner = if first.0 == StatusCode::OK {
        ("race-meks", &meks, first)
    } else {
        ("race-zhkh", &zhkh, second)
    };
    let (_, retry) = start_run(&h, winner.1, winner.0, total, &data_sha).await;
    assert_eq!(retry["run"]["id"], winner.2.1["run"]["id"]);

    let reserved: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_bytes - received_bytes), 0) FROM backup_runs
          WHERE status IN ('uploading', 'finalizing')",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(reserved as u64, data.len() as u64);
    assert!(free.0.load(Ordering::SeqCst) - reserved as u64 >= RESERVE_BYTES);
}

#[tokio::test]
async fn missing_storage_never_falls_back() {
    // Storage not configured at all.
    let h = harness().await;
    let (_, token) = register(&h, "meks").await;
    let data = b"bundle";
    let (status, body) =
        start_run(&h, &token, "no-storage", data.len() as u64, &digest(data)).await;
    assert_eq!(status, 503, "unconfigured storage: {body}");
    assert!(!h.state.config.data_dir.join("agents").exists());

    // Configured root, marker missing.
    let free = FakeFreeSpace::new(RESERVE_BYTES + 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, token) = register(&h, "meks").await;
    let root = h.backup_root.clone().unwrap();
    let marker = std::fs::read(root.join(STORAGE_MARKER)).unwrap();
    std::fs::remove_file(root.join(STORAGE_MARKER)).unwrap();

    let (status, body) = start_run(&h, &token, "no-marker", data.len() as u64, &digest(data)).await;
    assert_eq!(status, 503, "missing marker: {body}");
    assert!(!h.state.config.data_dir.join("agents").exists());

    // Configured root, root missing entirely.
    std::fs::remove_dir_all(&root).unwrap();
    let (status, body) = start_run(&h, &token, "no-root", data.len() as u64, &digest(data)).await;
    assert_eq!(status, 503, "missing root: {body}");
    assert!(!h.state.config.data_dir.join("agents").exists());

    // Restoring the exact provisioned marker re-enables storage; the root is
    // never silently recreated.
    std::fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(root.join(STORAGE_MARKER), marker).unwrap();
    let (status, body) = start_run(&h, &token, "restored", data.len() as u64, &digest(data)).await;
    assert_eq!(status, 200, "restored storage: {body}");

    // The marker UUID is pinned across requests and restarts: a different
    // provisioned tree is refused instead of silently accepting new uploads.
    let replacement = uuid::Uuid::new_v4().to_string();
    std::fs::write(root.join(STORAGE_MARKER), replacement).unwrap();
    let (status, body) = start_run(&h, &token, "replaced", data.len() as u64, &digest(data)).await;
    assert_eq!(status, 503, "replaced storage: {body}");
    assert!(
        h.state.config.data_dir.join("backup-storage-id").exists(),
        "the marker pin must be durable"
    );
}

#[tokio::test]
async fn reconciliation_without_storage_does_not_block_boot() {
    // A database can contain active rows while an operator temporarily
    // disables backup storage. Monitoring must still start.
    let h = harness().await;
    let (agent, _) = h
        .state
        .backups
        .register_agent_at(
            flatline_backend::backups::NewAgent {
                name: "meks".to_string(),
                monitor_id: None,
                enabled: true,
                interval_seconds: 86400,
                retention_count: 7,
            },
            chrono::Utc::now(),
        )
        .await
        .unwrap();
    let now = chrono::Utc::now();
    h.state
        .backups
        .insert_run_metadata_at(
            &agent.id,
            StartRun {
                agent_version: None,
                client_run_id: "active-without-storage".to_string(),
                export_started_at: (now - chrono::Duration::minutes(5)).to_rfc3339(),
                export_finished_at: Some(now.to_rfc3339()),
                total_bytes: Some(1024),
                sha256: Some("a".repeat(64)),
                source_summary: None,
            },
            now,
        )
        .await
        .unwrap();

    h.state
        .backups
        .reconcile(now.timestamp_millis())
        .await
        .expect("disabled storage must not fail boot reconciliation");
    let status: String = sqlx::query_scalar("SELECT status FROM backup_runs")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(status, "uploading");
}

/// Records every fault point with the thread that reached it.
#[derive(Default)]
struct RecordingFaults {
    events: Mutex<Vec<(FaultPoint, std::thread::ThreadId)>>,
}

impl RecordingFaults {
    fn take(&self) -> Vec<(FaultPoint, std::thread::ThreadId)> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }
}

impl FaultInjector for RecordingFaults {
    fn hit(&self, point: FaultPoint) -> io::Result<()> {
        self.events
            .lock()
            .unwrap()
            .push((point, std::thread::current().id()));
        Ok(())
    }
}

/// Review H2: finalization hashed the bundle twice on a runtime worker.
/// `#[tokio::test]` uses a current-thread runtime, so every async step runs
/// on this test thread; storage work must happen elsewhere (the blocking
/// pool), and the bundle must be hashed exactly once per finalization.
#[tokio::test]
async fn finalize_hashes_once_off_the_runtime_thread() {
    let runtime_thread = std::thread::current().id();
    let faults = Arc::new(RecordingFaults::default());
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, Arc::clone(&faults) as Arc<dyn FaultInjector>).await;
    let (_, token) = register(&h, "meks").await;
    let data = vec![7u8; 4096];

    let (status, started) = start_run(&h, &token, "hash-once", 4096, &digest(&data)).await;
    assert_eq!(status, 200, "{started}");
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let (status, uploaded) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200, "{uploaded}");
    let (status, completed) = complete(&h, &token, &run_id).await;
    assert_eq!(status, 200, "{completed}");
    assert_eq!(completed["run"]["status"], "completed");

    let events = faults.take();
    let hashes = events
        .iter()
        .filter(|(point, _)| *point == FaultPoint::FullHash)
        .count();
    assert_eq!(hashes, 1, "finalize must hash the bundle exactly once");
    for (point, thread) in &events {
        if *point == FaultPoint::AfterDbUpdate {
            continue; // SQLite bookkeeping, not file I/O
        }
        assert_ne!(
            *thread, runtime_thread,
            "{point:?} ran on the async runtime thread"
        );
    }

    // Boot reconciliation of an interrupted finalization: same guarantees.
    let (status, started) = start_run(&h, &token, "reconcile-once", 4096, &digest(&data)).await;
    assert_eq!(status, 200, "{started}");
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200);
    sqlx::query("UPDATE backup_runs SET status = 'finalizing' WHERE id = ?")
        .bind(&run_id)
        .execute(&h.pool)
        .await
        .unwrap();
    faults.take();
    h.state.backups.reconcile_storage().await.unwrap();
    let events = faults.take();
    assert_eq!(
        events
            .iter()
            .filter(|(point, _)| *point == FaultPoint::FullHash)
            .count(),
        1,
        "reconciliation must hash once"
    );
    assert!(
        events.iter().all(|(_, thread)| *thread != runtime_thread),
        "reconciliation file I/O ran on the runtime thread"
    );
    let (_, probe) =
        common::get_json(&h.app, &format!("/api/backup/v1/runs/{run_id}"), &token).await;
    assert_eq!(probe["run"]["status"], "completed");
}

/// Review L2: complete_run allocated a lock entry before checking
/// ownership, and entries were never removed.
#[tokio::test]
async fn run_locks_are_owned_and_pruned() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, meks) = register(&h, "meks").await;
    let (_, zhkh) = register(&h, "zhkhteam").await;
    let data = vec![3u8; 4096];
    let (_, started) = start_run(&h, &meks, "locks", 4096, &digest(&data)).await;
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    // Unknown and foreign ids never allocate an entry.
    for id in [uuid::Uuid::new_v4().to_string(), "not-a-uuid".to_string()] {
        let (status, _) = complete(&h, &meks, &id).await;
        assert_eq!(status, 404);
    }
    let (status, _) = complete(&h, &zhkh, &run_id).await;
    assert_eq!(status, 404, "another agent's run is indistinguishable");
    let (status, _) = put(&h, &zhkh, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 404);
    assert_eq!(h.state.backups.run_lock_entries(), 0);

    // Real work releases its entry afterwards, including failures.
    let (status, _) = complete(&h, &meks, &run_id).await;
    assert_eq!(status, 409, "incomplete upload cannot complete");
    let (status, _) = put(&h, &meks, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200);
    let (status, _) = complete(&h, &meks, &run_id).await;
    assert_eq!(status, 200);
    assert_eq!(
        h.state.backups.run_lock_entries(),
        0,
        "finished runs must not keep lock entries"
    );
}

fn stalled_body(prefix: usize) -> Body {
    Body::from_stream(async_stream::stream! {
        yield Ok::<_, io::Error>(axum::body::Bytes::from(vec![1u8; prefix]));
        std::future::pending::<()>().await;
    })
}

/// Review H3: a half-open connection held the run lock and an upload slot
/// forever, because the body was read with no timeout under both.
#[tokio::test]
async fn stalled_chunk_bodies_release_slots_and_locks() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let backups = Arc::clone(&h.state.backups);
    backups.set_upload_limits(flatline_backend::backups::UploadLimits {
        slot_wait: std::time::Duration::from_millis(100),
        lock_wait: std::time::Duration::from_millis(100),
        body_idle: std::time::Duration::from_millis(300),
        body_total: std::time::Duration::from_secs(5),
    });
    let (agent_id, token) = register(&h, "meks").await;
    let data = vec![9u8; 4096];
    let (_, started) = start_run(&h, &token, "stalled", 4096, &digest(&data)).await;
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    // Four senders stall on the same run, occupying every slot.
    let mut stalled = Vec::new();
    for _ in 0..4 {
        let backups = Arc::clone(&backups);
        let (agent_id, run_id, sha) = (agent_id.clone(), run_id.clone(), digest(&data));
        stalled.push(tokio::spawn(async move {
            backups
                .put_chunk(&agent_id, &run_id, 0, 0, &sha, stalled_body(1024))
                .await
        }));
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // A fifth sender is told to come back instead of queueing forever.
    let (status, busy) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 503, "slots full must be retryable: {busy}");
    assert_eq!(busy["error"], "busy");

    for task in stalled {
        let result = task.await.unwrap();
        assert!(
            matches!(result, Err(flatline_backend::backups::Error::Timeout(_))),
            "stalled body must time out: {result:?}"
        );
    }
    assert_eq!(h.state.backups.run_lock_entries(), 0);

    // Over HTTP the same stall is a 408, and afterwards the run is usable.
    let request = Request::builder()
        .method("PUT")
        .uri(format!("/api/backup/v1/runs/{run_id}/chunks/0"))
        .header("authorization", format!("Bearer {token}"))
        .header("x-backup-offset", "0")
        .header("x-backup-sha256", digest(&data))
        .body(stalled_body(16))
        .unwrap();
    let (status, timed_out) = send(&h.app, request).await;
    assert_eq!(status, 408, "{timed_out}");

    let (status, uploaded) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200, "locks and slots were released: {uploaded}");
    let (status, _) = complete(&h, &token, &run_id).await;
    assert_eq!(status, 200);
}

/// Shutdown aborts a body read that is still waiting on the network.
#[tokio::test]
async fn shutdown_aborts_pending_body_reads() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (agent_id, token) = register(&h, "meks").await;
    let data = vec![9u8; 4096];
    let (_, started) = start_run(&h, &token, "shutdown", 4096, &digest(&data)).await;
    let run_id = started["run"]["id"].as_str().unwrap().to_string();

    let backups = Arc::clone(&h.state.backups);
    let sha = digest(&data);
    let pending = tokio::spawn(async move {
        backups
            .put_chunk(&agent_id, &run_id, 0, 0, &sha, stalled_body(8))
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    h.state.backups.shutdown();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
        .await
        .expect("shutdown must not wait for the default body timeout")
        .unwrap();
    assert!(matches!(
        result,
        Err(flatline_backend::backups::Error::Unavailable(_))
    ));
}

/// Review H1: every 409 from POST /runs looked "terminal" to the agent,
/// including "another run is uploading", so the agent quarantined and
/// re-exported in a loop. Conflicts now carry distinct codes, and an agent
/// can abandon its own active run when it no longer holds the bundle.
#[tokio::test]
async fn start_conflicts_are_distinguishable_and_abandonable() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, meks) = register(&h, "meks").await;
    let (_, zhkh) = register(&h, "zhkhteam").await;
    let first = vec![1u8; 4096];
    let second = vec![2u8; 4096];

    let (status, started) = start_run(&h, &meks, "bundle-a", 4096, &digest(&first)).await;
    assert_eq!(status, 200, "{started}");
    let run_a = started["run"]["id"].as_str().unwrap().to_string();

    // A second bundle while the first is still uploading: active_run, with
    // the identity the agent needs to decide between resume and abandon.
    let (status, conflict) = start_run(&h, &meks, "bundle-b", 4096, &digest(&second)).await;
    assert_eq!(status, 409);
    assert_eq!(conflict["error"], "active_run", "{conflict}");
    assert_eq!(conflict["activeRunId"], run_a.as_str());
    assert_eq!(conflict["activeClientRunId"], "bundle-a");

    // The same clientRunId with other parameters is a different code.
    let (status, conflict) = start_run(&h, &meks, "bundle-a", 4096, &digest(&second)).await;
    assert_eq!(status, 409);
    assert_eq!(conflict["error"], "params_conflict", "{conflict}");

    // Resuming with identical parameters still returns the run.
    let (status, resumed) = start_run(&h, &meks, "bundle-a", 4096, &digest(&first)).await;
    assert_eq!(status, 200);
    assert_eq!(resumed["run"]["id"], run_a.as_str());

    // Another agent cannot abandon it.
    let abandon = |token: &str, id: &str| {
        request(
            "POST",
            &format!("/api/backup/v1/runs/{id}/abandon"),
            Some(token),
            None,
        )
    };
    let (status, _) = send(&h.app, abandon(&zhkh, &run_a)).await;
    assert_eq!(status, 404);

    let (status, abandoned) = send(&h.app, abandon(&meks, &run_a)).await;
    assert_eq!(status, 200, "{abandoned}");
    assert_eq!(abandoned["run"]["status"], "failed");
    assert_eq!(abandoned["run"]["errorCode"], "upload_abandoned");
    let (status, again) = send(&h.app, abandon(&meks, &run_a)).await;
    assert_eq!(status, 200, "abandon is idempotent: {again}");

    // The abandoned run is terminal; the new bundle can now start.
    let (status, terminal) = start_run(&h, &meks, "bundle-a", 4096, &digest(&first)).await;
    assert_eq!(status, 409);
    assert_eq!(terminal["error"], "run_terminal", "{terminal}");
    let (status, terminal) = complete(&h, &meks, &run_a).await;
    assert_eq!(status, 409);
    assert_eq!(terminal["error"], "run_terminal");
    let (status, started) = start_run(&h, &meks, "bundle-b", 4096, &digest(&second)).await;
    assert_eq!(status, 200, "{started}");
    let run_b = started["run"]["id"].as_str().unwrap().to_string();
    let (status, _) = put(&h, &meks, &run_b, 0, 0, second.clone()).await;
    assert_eq!(status, 200);
    let (status, _) = complete(&h, &meks, &run_b).await;
    assert_eq!(status, 200);

    // A completed run cannot be abandoned.
    let (status, terminal) = send(&h.app, abandon(&meks, &run_b)).await;
    assert_eq!(status, 409);
    assert_eq!(terminal["error"], "run_terminal");
}

async fn get_raw(h: &common::Harness, uri: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let response = h
        .app
        .clone()
        .oneshot(request("GET", uri, None, None))
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, body.to_vec())
}

/// Review M3: the dashboard buffered whole bundles with response.blob().
/// A short-lived, single-use ticket lets the browser stream a plain GET
/// without putting a long-lived credential in a URL.
#[tokio::test]
async fn download_tickets_are_short_lived_single_use_and_bound() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, token) = register(&h, "meks").await;
    let data: Vec<u8> = (0..5000u32).map(|i| (i % 253) as u8).collect();
    let (_, started) = start_run(&h, &token, "ticketed", data.len() as u64, &digest(&data)).await;
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let ticket_uri = format!("/api/v1/backup-runs/{run_id}/download-ticket");

    // Not completed yet: no ticket.
    let (status, _) = send(&h.app, request("POST", &ticket_uri, Some(&h.token), None)).await;
    assert_eq!(status, 404);
    let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
    assert_eq!(status, 200);
    let (status, _) = complete(&h, &token, &run_id).await;
    assert_eq!(status, 200);

    // Operator only: neither anonymous nor the agent credential.
    let (status, _) = send(&h.app, request("POST", &ticket_uri, None, None)).await;
    assert_eq!(status, 401);
    let (status, _) = send(&h.app, request("POST", &ticket_uri, Some(&token), None)).await;
    assert_eq!(status, 401);

    let (status, issued) = send(&h.app, request("POST", &ticket_uri, Some(&h.token), None)).await;
    assert_eq!(status, 200, "{issued}");
    assert_eq!(issued["runId"], run_id.as_str());
    let url = issued["url"].as_str().unwrap().to_string();
    assert!(url.starts_with("/api/v1/backup-downloads/"));
    assert!(!url.contains(&h.token), "no operator credential in the URL");
    let expires = chrono::DateTime::parse_from_rfc3339(issued["expiresAt"].as_str().unwrap())
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert!(expires - chrono::Utc::now() <= chrono::Duration::minutes(5));

    // A plain GET without Authorization streams the exact bytes once.
    let (status, headers, body) = get_raw(&h, &url).await;
    assert_eq!(status, 200);
    assert_eq!(body, data);
    assert_eq!(headers["cache-control"], "no-store");
    assert!(
        headers["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );
    let (status, _, _) = get_raw(&h, &url).await;
    assert_eq!(status, 404, "tickets are single-use");
    let (status, _, _) = get_raw(&h, "/api/v1/backup-downloads/fbd_forged").await;
    assert_eq!(status, 404);

    // Expired tickets are refused.
    h.state
        .backups
        .set_download_ticket_ttl(std::time::Duration::from_millis(10));
    let (_, issued) = send(&h.app, request("POST", &ticket_uri, Some(&h.token), None)).await;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let (status, _, _) = get_raw(&h, issued["url"].as_str().unwrap()).await;
    assert_eq!(status, 404, "expired tickets are refused");
}

/// Encryption is optional on the agent. A plain run reports
/// `encrypted: false` and downloads as `.tar`; a run without the field comes
/// from an agent that always encrypted, so it stays `.age`.
#[tokio::test]
async fn download_names_follow_the_reported_encryption() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, token) = register(&h, "meks").await;

    let cases = [
        ("plain", Some(false), ".tar"),
        ("sealed", Some(true), ".age"),
        ("legacy", None, ".age"),
    ];
    for (client_run_id, encrypted, extension) in cases {
        let data: Vec<u8> = client_run_id.bytes().cycle().take(4096).collect();
        let mut summary = json!({"databaseCount": 1, "objectCount": 0, "sourceBytes": 4096});
        if let Some(encrypted) = encrypted {
            summary["encrypted"] = json!(encrypted);
        }
        let (status, started) = start_run_with_summary(
            &h,
            &token,
            client_run_id,
            data.len() as u64,
            &digest(&data),
            summary,
        )
        .await;
        assert_eq!(status, 200, "{started}");
        let run_id = started["run"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            started["run"]["sourceSummary"]["encrypted"],
            json!(encrypted.unwrap_or(true)),
            "the stored summary says whether the bundle is encrypted"
        );
        let (status, _) = put(&h, &token, &run_id, 0, 0, data.clone()).await;
        assert_eq!(status, 200);
        let (status, _) = complete(&h, &token, &run_id).await;
        assert_eq!(status, 200);

        let ticket_uri = format!("/api/v1/backup-runs/{run_id}/download-ticket");
        let (_, issued) = send(&h.app, request("POST", &ticket_uri, Some(&h.token), None)).await;
        let (status, headers, body) = get_raw(&h, issued["url"].as_str().unwrap()).await;
        assert_eq!(status, 200);
        assert_eq!(body, data);
        let disposition = headers["content-disposition"].to_str().unwrap().to_string();
        assert!(
            disposition.ends_with(&format!("{extension}\"")),
            "{client_run_id}: {disposition}"
        );
    }
}

#[tokio::test]
async fn non_boolean_encrypted_flag_is_rejected() {
    let free = FakeFreeSpace::new(RESERVE_BYTES + 256 * 1024 * 1024);
    let h = harness_with_backups(free, ScriptedFaults::new()).await;
    let (_, token) = register(&h, "meks").await;
    let summary = json!({"databaseCount": 1, "encrypted": "yes"});
    let (status, body) =
        start_run_with_summary(&h, &token, "bad-flag", 10, &digest(b"0123456789"), summary).await;
    assert_eq!(status, 400, "{body}");
}
