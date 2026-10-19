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
use flatline_backend::backups::Backups;
use flatline_backend::backups::storage::{
    CHUNK_BYTES, FaultInjector, FaultPoint, FreeSpace, RESERVE_BYTES, STORAGE_MARKER,
};
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
                "sourceSummary": {
                    "databaseCount": 1,
                    "objectCount": 0,
                    "sourceBytes": total,
                },
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
    std::fs::write(root.join(STORAGE_MARKER), marker).unwrap();
    let (status, body) = start_run(&h, &token, "restored", data.len() as u64, &digest(data)).await;
    assert_eq!(status, 200, "restored storage: {body}");
}
