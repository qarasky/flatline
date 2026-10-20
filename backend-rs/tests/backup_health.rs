//! Retention, expiration, health transitions and operator verification.

mod common;

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode, header};
use common::{harness, harness_with_backups, request, send};
use flatline_backend::backups::storage::{FreeSpace, NoFaults, RESERVE_BYTES};
use flatline_backend::backups::{Backups, NewAgent, StartRun};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tower::ServiceExt;

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

fn free_space() -> Arc<FakeFreeSpace> {
    FakeFreeSpace::new(RESERVE_BYTES + 512 * 1024 * 1024)
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn sha(seed: char) -> String {
    std::iter::repeat_n(seed, 64).collect()
}

async fn register_at(
    h: &common::Harness,
    name: &str,
    monitor_id: Option<i64>,
    created: chrono::DateTime<chrono::Utc>,
) -> (String, String) {
    let (agent, token) = h
        .state
        .backups
        .register_agent_at(
            NewAgent {
                name: name.to_string(),
                monitor_id,
                enabled: true,
                interval_seconds: 86400,
                retention_count: 7,
            },
            created,
        )
        .await
        .unwrap();
    (agent.id, token)
}

struct RunSeed {
    id: String,
    agent_id: String,
    client_run_id: String,
    status: String,
    export_started_at: String,
    export_finished_at: Option<String>,
    created_at: String,
    completed_at: Option<String>,
    total_bytes: Option<i64>,
    received_bytes: i64,
    sha256: Option<String>,
    error_code: Option<String>,
    last_activity_at: Option<String>,
    delete_reason: Option<String>,
}

impl RunSeed {
    fn new(agent_id: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            agent_id: agent_id.to_string(),
            client_run_id: uuid::Uuid::new_v4().to_string(),
            status: "uploading".to_string(),
            export_started_at: now.clone(),
            export_finished_at: None,
            created_at: now.clone(),
            completed_at: None,
            total_bytes: Some(1024),
            received_bytes: 0,
            sha256: Some(sha('a')),
            error_code: None,
            last_activity_at: Some(now),
            delete_reason: None,
        }
    }
}

async fn insert_seed(pool: &SqlitePool, seed: &RunSeed) {
    sqlx::query(
        "INSERT INTO backup_runs
            (id, agent_id, client_run_id, status, export_started_at, export_finished_at,
             created_at, completed_at, total_bytes, received_bytes, sha256, error_code,
             last_activity_at, delete_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&seed.id)
    .bind(&seed.agent_id)
    .bind(&seed.client_run_id)
    .bind(&seed.status)
    .bind(&seed.export_started_at)
    .bind(&seed.export_finished_at)
    .bind(&seed.created_at)
    .bind(&seed.completed_at)
    .bind(seed.total_bytes)
    .bind(seed.received_bytes)
    .bind(&seed.sha256)
    .bind(&seed.error_code)
    .bind(&seed.last_activity_at)
    .bind(&seed.delete_reason)
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a completed run exported at `exported` (RFC3339) with no files.
async fn seed_completed(pool: &SqlitePool, agent_id: &str, exported: &str) -> String {
    let mut seed = RunSeed::new(agent_id);
    seed.status = "completed".to_string();
    seed.export_started_at = exported.to_string();
    seed.export_finished_at = Some(exported.to_string());
    seed.created_at = exported.to_string();
    seed.completed_at = Some(exported.to_string());
    seed.received_bytes = 1024;
    seed.last_activity_at = Some(exported.to_string());
    insert_seed(pool, &seed).await;
    seed.id
}

async fn status_of(pool: &SqlitePool, run_id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM backup_runs WHERE id = ?")
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn seven_successes_survive_failed_eighth() {
    let free = free_space();
    let h = harness_with_backups(Arc::clone(&free) as Arc<dyn FreeSpace>, Arc::new(NoFaults)).await;
    let (agent_id, _) = register_at(&h, "meks", None, chrono::Utc::now()).await;

    let mut completed = Vec::new();
    for hour in 1..=8 {
        let exported = (chrono::Utc::now() - chrono::Duration::hours(9 - hour)).to_rfc3339();
        completed.push(seed_completed(&h.pool, &agent_id, &exported).await);
    }

    // A failed attempt is not a recovery point and never evicts one.
    let mut failed = RunSeed::new(&agent_id);
    failed.status = "failed".to_string();
    failed.error_code = Some("export_failed".to_string());
    failed.export_finished_at = Some(chrono::Utc::now().to_rfc3339());
    failed.total_bytes = None;
    insert_seed(&h.pool, &failed).await;

    h.state
        .backups
        .maintain(chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();

    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, status FROM backup_runs
          WHERE agent_id = ? AND status IN ('completed', 'pruned')
          ORDER BY COALESCE(export_finished_at, completed_at, created_at) DESC, id DESC",
    )
    .bind(&agent_id)
    .fetch_all(&h.pool)
    .await
    .unwrap();
    assert_eq!(
        rows.iter()
            .filter(|(_, status)| status == "completed")
            .count(),
        7,
        "seven completed recovery points remain"
    );
    assert_eq!(status_of(&h.pool, &completed[0]).await, "pruned");
    assert_eq!(
        status_of(&h.pool, &failed.id).await,
        "failed",
        "failed runs are neither counted nor pruned"
    );
    for kept in &completed[1..] {
        assert_eq!(status_of(&h.pool, kept).await, "completed");
    }

    // Admission never evicts the last good backup to make room.
    free.0.store(RESERVE_BYTES, Ordering::SeqCst);
    let now = chrono::Utc::now();
    let refused = h
        .state
        .backups
        .start_run(
            &agent_id,
            StartRun {
                client_run_id: "no-space".to_string(),
                export_started_at: (now - chrono::Duration::minutes(10)).to_rfc3339(),
                export_finished_at: Some(now.to_rfc3339()),
                total_bytes: Some(1),
                sha256: Some(sha('b')),
                source_summary: None,
            },
        )
        .await;
    assert!(
        matches!(
            refused,
            Err(flatline_backend::backups::Error::Insufficient(_))
        ),
        "capacity refusal must not prune a good backup: {refused:?}"
    );
    for kept in &completed[1..] {
        assert_eq!(status_of(&h.pool, kept).await, "completed");
    }
}

#[tokio::test]
async fn pruning_and_expiration_resume_after_restart() {
    let free = free_space();
    let h = harness_with_backups(Arc::clone(&free) as Arc<dyn FreeSpace>, Arc::new(NoFaults)).await;
    let (agent_id, _) = register_at(&h, "meks", None, chrono::Utc::now()).await;

    let mut completed = Vec::new();
    for hour in 1..=8 {
        let exported = (chrono::Utc::now() - chrono::Duration::hours(9 - hour)).to_rfc3339();
        completed.push(seed_completed(&h.pool, &agent_id, &exported).await);
    }
    h.state
        .backups
        .maintain(chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();
    assert_eq!(status_of(&h.pool, &completed[0]).await, "pruned");

    // Simulate a crash between `deleting` and the unlink: bytes still exist.
    let stuck = completed[1].clone();
    let root = h.backup_root.as_ref().unwrap();
    let dir = root.join("agents").join(&agent_id).join(&stuck);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("bundle.age"), b"still-here").unwrap();
    sqlx::query(
        "UPDATE backup_runs SET status = 'deleting', delete_reason = 'retention' WHERE id = ?",
    )
    .bind(&stuck)
    .execute(&h.pool)
    .await
    .unwrap();

    let restarted = Backups::with_io(
        h.pool.clone(),
        Arc::clone(&h.state.config),
        Arc::clone(&h.state.events),
        Arc::clone(&free) as Arc<dyn FreeSpace>,
        Arc::new(NoFaults),
    );
    restarted
        .reconcile(chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();
    assert_eq!(status_of(&h.pool, &stuck).await, "pruned");
    assert!(!dir.exists(), "restart finishes the interrupted unlink");
    restarted
        .reconcile(chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();
    assert_eq!(status_of(&h.pool, &stuck).await, "pruned");

    // Abandoned uploads expire after 48 hours of no accepted activity.
    let now = chrono::Utc::now();
    let mut stale = RunSeed::new(&agent_id);
    stale.status = "uploading".to_string();
    stale.created_at = (now - chrono::Duration::hours(49)).to_rfc3339();
    stale.last_activity_at = Some((now - chrono::Duration::hours(49)).to_rfc3339());
    stale.received_bytes = 100;
    stale.total_bytes = Some(1024);
    stale.export_started_at = (now - chrono::Duration::hours(50)).to_rfc3339();
    insert_seed(&h.pool, &stale).await;
    let stale_dir = root.join("agents").join(&agent_id).join(&stale.id);
    std::fs::create_dir_all(&stale_dir).unwrap();
    std::fs::write(stale_dir.join("bundle.partial"), vec![9u8; 100]).unwrap();
    sqlx::query(
        "INSERT INTO backup_run_chunks (run_id, chunk_index, offset, size, sha256)
         VALUES (?, 0, 0, 100, ?)",
    )
    .bind(&stale.id)
    .bind(sha('c'))
    .execute(&h.pool)
    .await
    .unwrap();

    let mut fresh = RunSeed::new(&agent_id);
    fresh.created_at = (now - chrono::Duration::hours(47)).to_rfc3339();
    fresh.last_activity_at = Some((now - chrono::Duration::hours(47)).to_rfc3339());
    fresh.export_started_at = (now - chrono::Duration::hours(48)).to_rfc3339();
    insert_seed(&h.pool, &fresh).await;

    restarted.maintain(now.timestamp_millis()).await.unwrap();
    assert_eq!(status_of(&h.pool, &stale.id).await, "expired");
    assert!(!stale_dir.exists(), "expired bytes are removed");
    let chunks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup_run_chunks WHERE run_id = ?")
        .bind(&stale.id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(chunks, 0);
    assert_eq!(status_of(&h.pool, &fresh.id).await, "uploading");

    let reserved: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_bytes - received_bytes), 0) FROM backup_runs
          WHERE status IN ('uploading', 'finalizing')",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(reserved, 1024, "the expired run releases its reservation");

    // Restarting again is idempotent.
    let restarted = Backups::with_io(
        h.pool.clone(),
        Arc::clone(&h.state.config),
        Arc::clone(&h.state.events),
        Arc::clone(&free) as Arc<dyn FreeSpace>,
        Arc::new(NoFaults),
    );
    restarted.maintain(now.timestamp_millis()).await.unwrap();
    assert_eq!(status_of(&h.pool, &stale.id).await, "expired");
}

#[tokio::test]
async fn overdue_without_reports_is_detected() {
    let h = harness().await;
    let t0 = chrono::Utc::now() - chrono::Duration::days(3);
    let (agent_id, _) = register_at(&h, "meks", None, t0).await;

    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::hours(35)).timestamp_millis())
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT alert_state FROM backup_agents WHERE id = ?")
        .bind(&agent_id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(state, "pending", "36 hours have not elapsed");

    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::hours(37)).timestamp_millis())
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT alert_state FROM backup_agents WHERE id = ?")
        .bind(&agent_id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(state, "overdue", "a disconnected agent becomes overdue");
}

#[tokio::test]
async fn old_upload_does_not_clear_overdue() {
    let h = harness().await;
    let t0 = chrono::Utc::now();
    let (agent_id, _) = register_at(&h, "meks", None, t0).await;

    // Exported two days ago, received today: receipt time must not matter.
    let exported = (t0 - chrono::Duration::days(2)).to_rfc3339();
    let mut run = RunSeed::new(&agent_id);
    run.status = "completed".to_string();
    run.export_started_at = exported.clone();
    run.export_finished_at = Some(exported.clone());
    run.created_at = t0.to_rfc3339();
    run.completed_at = Some(t0.to_rfc3339());
    run.received_bytes = 1024;
    run.last_activity_at = Some(t0.to_rfc3339());
    insert_seed(&h.pool, &run).await;

    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::minutes(10)).timestamp_millis())
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT alert_state FROM backup_agents WHERE id = ?")
        .bind(&agent_id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(state, "overdue");
}

async fn fake_telegram() -> (String, Arc<StdMutex<Vec<Value>>>) {
    let records = Arc::new(StdMutex::new(Vec::new()));
    let app = Router::new()
        .fallback(record_telegram)
        .with_state(Arc::clone(&records));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), records)
}

async fn record_telegram(
    State(records): State<Arc<StdMutex<Vec<Value>>>>,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    records.lock().unwrap().push(body);
    axum::Json(json!({ "ok": true }))
}

#[tokio::test]
async fn alert_transitions_survive_restart() {
    let h = harness().await;
    let (telegram_url, records) = fake_telegram().await;
    let monitor_id: i64 = sqlx::query_scalar(
        "INSERT INTO monitors (name, type, active) VALUES ('MEKS', 'push', 1) RETURNING id",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let config = json!({
        "telegramBotToken": "123:abc",
        "telegramChatID": "42",
        "telegramServerUrl": telegram_url,
    })
    .to_string();
    let notification_id: i64 = sqlx::query_scalar(
        "INSERT INTO notifications (name, type, active, config)
         VALUES ('test', 'telegram', 1, ?) RETURNING id",
    )
    .bind(config)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO monitor_notifications (monitor_id, notification_id) VALUES (?, ?)")
        .bind(monitor_id)
        .bind(notification_id)
        .execute(&h.pool)
        .await
        .unwrap();

    let t0 = chrono::Utc::now();
    let (agent_id, _) = register_at(&h, "meks", Some(monitor_id), t0).await;

    h.state
        .backups
        .evaluate_health(t0.timestamp_millis())
        .await
        .unwrap();
    assert!(records.lock().unwrap().is_empty(), "pending is silent");

    let mut failed = RunSeed::new(&agent_id);
    failed.status = "failed".to_string();
    failed.error_code = Some("export_failed".to_string());
    failed.export_finished_at = Some((t0 + chrono::Duration::minutes(5)).to_rfc3339());
    failed.created_at = (t0 + chrono::Duration::minutes(5)).to_rfc3339();
    failed.total_bytes = None;
    insert_seed(&h.pool, &failed).await;

    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::minutes(10)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(records.lock().unwrap().len(), 1, "failure notifies once");
    assert!(
        records.lock().unwrap()[0]["text"]
            .as_str()
            .unwrap()
            .contains("last export failed")
    );

    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::minutes(11)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(records.lock().unwrap().len(), 1, "no repeat while failed");

    // A fresh service over the same database is the restart: the persisted
    // transition prevents a duplicate alert.
    let restarted = Backups::with_io(
        h.pool.clone(),
        Arc::clone(&h.state.config),
        Arc::clone(&h.state.events),
        FakeFreeSpace::new(RESERVE_BYTES + 512 * 1024 * 1024) as Arc<dyn FreeSpace>,
        Arc::new(NoFaults),
    );
    restarted
        .evaluate_health((t0 + chrono::Duration::minutes(12)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(records.lock().unwrap().len(), 1, "restart is silent");

    let exported = (t0 + chrono::Duration::minutes(13)).to_rfc3339();
    seed_completed(&h.pool, &agent_id, &exported).await;
    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::minutes(14)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(records.lock().unwrap().len(), 2, "recovery notifies once");
    assert!(
        records.lock().unwrap()[1]["text"]
            .as_str()
            .unwrap()
            .contains("recovery")
    );

    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::hours(50)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(records.lock().unwrap().len(), 3, "overdue notifies once");
    assert!(
        records.lock().unwrap()[2]["text"]
            .as_str()
            .unwrap()
            .contains("36 hours")
    );
    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::hours(51)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(records.lock().unwrap().len(), 3);

    sqlx::query("UPDATE backup_agents SET enabled = 0 WHERE id = ?")
        .bind(&agent_id)
        .execute(&h.pool)
        .await
        .unwrap();
    h.state
        .backups
        .evaluate_health((t0 + chrono::Duration::hours(52)).timestamp_millis())
        .await
        .unwrap();
    assert_eq!(
        records.lock().unwrap().len(),
        3,
        "disabled agents do not alert"
    );
}

#[tokio::test]
async fn verification_is_operator_only() {
    let free = free_space();
    let h = harness_with_backups(Arc::clone(&free) as Arc<dyn FreeSpace>, Arc::new(NoFaults)).await;
    let (agent_id, agent_token) = register_at(&h, "meks", None, chrono::Utc::now()).await;

    let data = vec![4u8; 2048];
    let now = chrono::Utc::now();
    let run = h
        .state
        .backups
        .start_run(
            &agent_id,
            StartRun {
                client_run_id: "verify-run".to_string(),
                export_started_at: (now - chrono::Duration::minutes(10)).to_rfc3339(),
                export_finished_at: Some(now.to_rfc3339()),
                total_bytes: Some(data.len() as i64),
                sha256: Some(digest(&data)),
                source_summary: None,
            },
        )
        .await
        .unwrap();
    h.state
        .backups
        .put_chunk(
            &agent_id,
            &run.id,
            0,
            0,
            &digest(&data),
            Body::from(data.clone()),
        )
        .await
        .unwrap();
    h.state
        .backups
        .complete_run(&agent_id, &run.id)
        .await
        .unwrap();

    // Transfer verified, never restore tested without an explicit result.
    let (status, body) = common::get_json(
        &h.app,
        &format!("/api/v1/backup-agents/{agent_id}/runs"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["runs"][0]["status"], "completed");
    assert!(body["runs"][0]["archiveVerification"].is_null());
    assert!(body["runs"][0]["restoreVerification"].is_null());

    // Agents cannot assert verification.
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/backup-runs/{}/verification", run.id),
            Some(&agent_token),
            Some(json!({
                "kind": "restore",
                "status": "passed",
                "checkedAt": chrono::Utc::now().to_rfc3339(),
                "summary": "agent claim",
            })),
        ),
    )
    .await;
    assert_eq!(status, 401);

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/backup-runs/{}/verification", run.id),
            Some(&h.token),
            Some(json!({
                "kind": "archive",
                "status": "passed",
                "checkedAt": chrono::Utc::now().to_rfc3339(),
                "summary": "offline verify: 1 database, 0 objects",
            })),
        ),
    )
    .await;
    assert_eq!(status, 200, "archive verification: {body}");
    assert_eq!(body["run"]["archiveVerification"]["status"], "passed");
    assert!(body["run"]["restoreVerification"].is_null());

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/backup-runs/{}/verification", run.id),
            Some(&h.token),
            Some(json!({
                "kind": "restore",
                "status": "failed",
                "checkedAt": chrono::Utc::now().to_rfc3339(),
                "summary": "scratch restore: extension missing",
            })),
        ),
    )
    .await;
    assert_eq!(status, 200, "restore verification: {body}");
    assert_eq!(body["run"]["restoreVerification"]["status"], "failed");

    let (_, agents) = common::get_json(&h.app, "/api/v1/backup-agents", &h.token).await;
    assert_eq!(
        agents["agents"][0]["latestArchiveVerification"]["runId"],
        run.id
    );
    assert_eq!(
        agents["agents"][0]["latestRestoreVerification"]["status"],
        "failed"
    );

    // A non-completed run cannot be presented as verified.
    let mut failed = RunSeed::new(&agent_id);
    failed.status = "failed".to_string();
    failed.error_code = Some("export_failed".to_string());
    insert_seed(&h.pool, &failed).await;
    let (status, _) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/backup-runs/{}/verification", failed.id),
            Some(&h.token),
            Some(json!({
                "kind": "archive",
                "status": "passed",
                "checkedAt": chrono::Utc::now().to_rfc3339(),
                "summary": "too early",
            })),
        ),
    )
    .await;
    assert_eq!(status, 409);

    // Authenticated download streams the completed bundle as bytes.
    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/backup-runs/{}/download", run.id))
                .header("authorization", format!("Bearer {}", h.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(
        response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains(&run.id)
    );
    let downloaded = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(downloaded.as_ref(), data.as_slice());

    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/backup-runs/{}/download", run.id))
                .header("authorization", format!("Bearer {agent_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = h
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/backup-runs/{}/download", failed.id))
                .header("authorization", format!("Bearer {}", h.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn latest_failure_survives_receipt_order() {
    let h = harness().await;
    let now = chrono::Utc::now();
    let (agent_id, _) = register_at(&h, "ordering", None, now).await;

    // A failed attempt at T must remain the latest attempt even when an older
    // export is received later.
    let mut failed = RunSeed::new(&agent_id);
    failed.status = "failed".to_string();
    failed.error_code = Some("export_failed".to_string());
    failed.export_started_at = (now - chrono::Duration::minutes(5)).to_rfc3339();
    failed.created_at = (now - chrono::Duration::minutes(5)).to_rfc3339();
    failed.export_finished_at = Some((now - chrono::Duration::minutes(4)).to_rfc3339());
    failed.total_bytes = None;
    insert_seed(&h.pool, &failed).await;

    let mut old_success = RunSeed::new(&agent_id);
    old_success.status = "completed".to_string();
    old_success.export_started_at = (now - chrono::Duration::days(2)).to_rfc3339();
    old_success.export_finished_at = Some((now - chrono::Duration::days(2)).to_rfc3339());
    old_success.created_at = now.to_rfc3339();
    old_success.completed_at = Some(now.to_rfc3339());
    old_success.received_bytes = 1024;
    insert_seed(&h.pool, &old_success).await;

    let (_, agents) = common::get_json(&h.app, "/api/v1/backup-agents", &h.token).await;
    let ordering = agents["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == agent_id)
        .unwrap();
    assert_eq!(ordering["latestRun"]["status"], "failed");
    assert_eq!(ordering["lastErrorCode"], "export_failed");
    assert_eq!(ordering["health"], "failed");
}

/// Review M2: alerts skipped agents without a monitor, so an unlinked agent
/// or one whose monitor was deleted (ON DELETE SET NULL) never alerted, and
/// upload-phase failures (507 full office storage) were never reported.
#[tokio::test]
async fn unlinked_agents_and_upload_failures_still_alert() {
    let h = harness().await;
    let (telegram_url, records) = fake_telegram().await;
    let config = json!({
        "telegramBotToken": "123:abc",
        "telegramChatID": "42",
        "telegramServerUrl": telegram_url,
    })
    .to_string();
    sqlx::query(
        "INSERT INTO notifications (name, type, active, is_default, config)
         VALUES ('office', 'telegram', 1, 1, ?)",
    )
    .bind(config)
    .execute(&h.pool)
    .await
    .unwrap();
    let monitor_id: i64 = sqlx::query_scalar(
        "INSERT INTO monitors (name, type, active) VALUES ('MEKS', 'push', 1) RETURNING id",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();

    let t0 = chrono::Utc::now();
    let (linked_id, linked_token) = register_at(&h, "meks", Some(monitor_id), t0).await;
    let (_, unlinked_token) = register_at(&h, "zhkhteam", None, t0).await;
    sqlx::query("DELETE FROM monitors WHERE id = ?")
        .bind(monitor_id)
        .execute(&h.pool)
        .await
        .unwrap();
    let orphaned: Option<i64> =
        sqlx::query_scalar("SELECT monitor_id FROM backup_agents WHERE id = ?")
            .bind(&linked_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(orphaned, None, "monitor deletion unlinks the agent");

    // The agent reports a 507 during upload under a derived clientRunId.
    // Canonical storage form, as the receiver writes it.
    let exported = (t0 - chrono::Duration::minutes(30))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for (token, code) in [
        (&linked_token, "office_storage_full"),
        (&unlinked_token, "upload_failed"),
    ] {
        let (status, body) = send(
            &h.app,
            request(
                "POST",
                "/api/backup/v1/failures",
                Some(token),
                Some(json!({
                    "clientRunId": format!("bundle-1-{code}"),
                    "exportStartedAt": exported,
                    "code": code,
                })),
            ),
        )
        .await;
        assert_eq!(status, 200, "{code} must be accepted: {body}");
    }

    h.state
        .backups
        .evaluate_health(t0.timestamp_millis())
        .await
        .unwrap();
    let texts: Vec<String> = records
        .lock()
        .unwrap()
        .iter()
        .map(|record| record["text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(texts.len(), 2, "both agents alert via the default: {texts:?}");
    assert!(
        texts
            .iter()
            .any(|text| text.contains("meks") && text.contains("office_storage_full"))
    );
    assert!(
        texts
            .iter()
            .any(|text| text.contains("zhkhteam") && text.contains("not delivered"))
    );

    // The same bundle is delivered later: its completion shares the export
    // time of the failure report and must win, then recovery is announced.
    let mut delivered = RunSeed::new(&linked_id);
    delivered.status = "completed".to_string();
    delivered.export_started_at = exported.clone();
    delivered.export_finished_at = Some(exported.clone());
    delivered.completed_at = Some(t0.to_rfc3339());
    delivered.received_bytes = 1024;
    insert_seed(&h.pool, &delivered).await;
    for _ in 0..3 {
        // Repeated evaluations: the tie-break must be deterministic.
        h.state
            .backups
            .evaluate_health((t0 + chrono::Duration::minutes(1)).timestamp_millis())
            .await
            .unwrap();
    }
    let texts: Vec<String> = records
        .lock()
        .unwrap()
        .iter()
        .map(|record| record["text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert!(texts[2].contains("meks") && texts[2].contains("recovery"));
}

/// Review L3: a failure report turned deleting/pruned/expired (and
/// finalizing) runs into failed, rewriting retention and expiry state, and
/// accepted unbounded clientRunIds.
#[tokio::test]
async fn failure_reports_only_fail_uploading_runs() {
    let h = harness().await;
    let t0 = chrono::Utc::now();
    let (agent_id, token) = register_at(&h, "meks", None, t0).await;
    let report = |client_run_id: String| {
        request(
            "POST",
            "/api/backup/v1/failures",
            Some(&token),
            Some(json!({
                "clientRunId": client_run_id,
                "exportStartedAt": t0.to_rfc3339(),
                "code": "export_failed",
            })),
        )
    };

    for status in ["finalizing", "completed", "deleting", "pruned", "expired"] {
        let mut seed = RunSeed::new(&agent_id);
        seed.status = status.to_string();
        if status == "deleting" {
            seed.delete_reason = Some("retention".to_string());
        }
        insert_seed(&h.pool, &seed).await;
        let (code, body) = send(&h.app, report(seed.client_run_id.clone())).await;
        assert_eq!(code, 409, "{status}: {body}");
        assert_eq!(body["error"], "run_terminal", "{status}");
        assert_eq!(status_of(&h.pool, &seed.id).await, status, "{status} kept");
    }

    // An uploading run can still fail, idempotently.
    let seed = RunSeed::new(&agent_id);
    insert_seed(&h.pool, &seed).await;
    let (code, body) = send(&h.app, report(seed.client_run_id.clone())).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(status_of(&h.pool, &seed.id).await, "failed");
    let (code, _) = send(&h.app, report(seed.client_run_id.clone())).await;
    assert_eq!(code, 200);

    let (code, _) = send(&h.app, report("x".repeat(129))).await;
    assert_eq!(code, 400, "clientRunId is bounded");
    let (code, _) = send(&h.app, report(String::new())).await;
    assert_eq!(code, 400);
    let (code, _) = send(&h.app, report("x".repeat(128))).await;
    assert_eq!(code, 200);
}
