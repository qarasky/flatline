//! Named backup agents: identity, credentials, ownership and run metadata.
//!
//! These tests exercise the operator API and the agent-facing run API against
//! a real SQLite database. Receiver behaviour (chunks, finalization) lands in
//! the next task; the metadata boundary is what matters here.

mod common;

use common::{harness, request, send};
use flatline_backend::backups::{Error as BackupError, StartRun};
use serde_json::{Value, json};

async fn create_monitor(h: &common::Harness, body: Value) -> i64 {
    let (status, response) = send(
        &h.app,
        request("POST", "/api/v1/monitors", Some(&h.token), Some(body)),
    )
    .await;
    assert_eq!(status, 201, "monitor create failed: {response}");
    response["monitor"]["id"].as_i64().unwrap()
}

async fn register_agent(h: &common::Harness, body: Value) -> (u16, Value) {
    let (status, response) = send(
        &h.app,
        request("POST", "/api/v1/backup-agents", Some(&h.token), Some(body)),
    )
    .await;
    (status.as_u16(), response)
}

fn agent_body(name: &str, monitor_id: Option<i64>) -> Value {
    json!({
        "name": name,
        "monitorId": monitor_id,
        "enabled": true,
        "intervalSeconds": 86400,
        "retentionCount": 7,
    })
}

fn sha(seed: char) -> String {
    std::iter::repeat_n(seed, 64).collect()
}

fn valid_start(client_run_id: &str, now: chrono::DateTime<chrono::Utc>) -> StartRun {
    StartRun {
        client_run_id: client_run_id.to_string(),
        export_started_at: (now - chrono::Duration::minutes(30)).to_rfc3339(),
        export_finished_at: Some((now - chrono::Duration::minutes(1)).to_rfc3339()),
        total_bytes: Some(4096),
        sha256: Some(sha('a')),
        source_summary: Some(json!({
            "databaseCount": 1,
            "objectCount": 2,
            "sourceBytes": 4096,
        })),
    }
}

#[tokio::test]
async fn multiple_agents_share_monitor_but_not_credentials() {
    let h = harness().await;
    let monitor = create_monitor(
        &h,
        json!({ "name": "MEKS", "type": "push", "active": true }),
    )
    .await;
    let push_token = {
        let (_, body) =
            common::get_json(&h.app, &format!("/api/v1/monitors/{monitor}"), &h.token).await;
        body["monitor"]["pushToken"].as_str().unwrap().to_string()
    };

    let (status, meks) = register_agent(&h, agent_body("meks", Some(monitor))).await;
    assert_eq!(status, 201, "meks registration failed: {meks}");
    let (status, zhkh) = register_agent(&h, agent_body("zhkhteam", Some(monitor))).await;
    assert_eq!(status, 201, "zhkh registration failed: {zhkh}");

    let meks_id = meks["agent"]["id"].as_str().unwrap().to_string();
    let zhkh_id = zhkh["agent"]["id"].as_str().unwrap().to_string();
    let meks_token = meks["token"].as_str().unwrap().to_string();
    let zhkh_token = zhkh["token"].as_str().unwrap().to_string();
    assert_ne!(meks_id, zhkh_id, "UUID is the identity, not the name");
    assert_ne!(meks_token, zhkh_token, "credentials are per agent");
    assert_eq!(meks_id.len(), 36, "server-generated UUID");
    assert!(meks_token.starts_with("flatline_backup_"));

    // The list exposes credential state, never the credential or its hash.
    let (status, list) = common::get_json(&h.app, "/api/v1/backup-agents", &h.token).await;
    assert_eq!(status, 200);
    let agents = list["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2);
    assert!(list["nextCursor"].is_null());
    for agent in agents {
        assert_eq!(agent["monitorId"], monitor);
        assert_eq!(agent["credentialActive"], true);
        assert_eq!(agent["health"], "pending");
        assert!(agent.get("token").is_none());
        assert!(agent.get("tokenHash").is_none());
        assert!(agent.get("hash").is_none());
    }

    // Operator and push tokens cannot use the agent API.
    for token in [&h.token, &push_token] {
        let (status, _) = common::get_json(
            &h.app,
            "/api/backup/v1/runs/00000000-0000-0000-0000-000000000000",
            token,
        )
        .await;
        assert_eq!(status, 401, "non-agent credential must not authenticate");
    }

    // A backup token cannot use the operator API.
    let (status, _) = common::get_json(&h.app, "/api/v1/backup-agents", &meks_token).await;
    assert_eq!(status, 401);

    // Seed a run owned by ZHKH; MEKS must not see it (404, not 403).
    let zhkh_run = "11111111-1111-4111-8111-111111111111";
    sqlx::query(
        "INSERT INTO backup_runs
            (id, agent_id, client_run_id, status, export_started_at, created_at, total_bytes, received_bytes, sha256)
         VALUES (?, ?, 'seed-run', 'completed', ?, ?, 4096, 4096, ?)",
    )
    .bind(zhkh_run)
    .bind(&zhkh_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(sha('b'))
    .execute(&h.pool)
    .await
    .unwrap();

    let (status, body) = common::get_json(
        &h.app,
        &format!("/api/backup/v1/runs/{zhkh_run}"),
        &meks_token,
    )
    .await;
    assert_eq!(status, 404, "cross-agent access answers 404: {body}");
    let (status, body) = common::get_json(
        &h.app,
        &format!("/api/backup/v1/runs/{zhkh_run}"),
        &zhkh_token,
    )
    .await;
    assert_eq!(status, 200, "owner may read its own run: {body}");
    assert_eq!(body["run"]["id"], zhkh_run);
    assert_eq!(body["run"]["agentId"], zhkh_id);
}

#[tokio::test]
async fn monitor_deletion_preserves_agents() {
    let h = harness().await;
    let monitor = create_monitor(
        &h,
        json!({ "name": "MEKS", "type": "http", "url": "http://example.com" }),
    )
    .await;
    let (status, created) = register_agent(&h, agent_body("meks", Some(monitor))).await;
    assert_eq!(status, 201);
    let agent_id = created["agent"]["id"].as_str().unwrap().to_string();

    let (status, _) = send(
        &h.app,
        request(
            "DELETE",
            &format!("/api/v1/monitors/{monitor}"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, 200);

    let (_, list) = common::get_json(&h.app, "/api/v1/backup-agents", &h.token).await;
    let agents = list["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1, "deleting a monitor keeps its agents");
    assert_eq!(agents[0]["id"], agent_id);
    assert!(agents[0]["monitorId"].is_null());
}

#[tokio::test]
async fn rotation_and_revocation_preserve_history() {
    let h = harness().await;
    let (status, created) = register_agent(&h, agent_body("meks", None)).await;
    assert_eq!(status, 201);
    let agent_id = created["agent"]["id"].as_str().unwrap().to_string();
    let old_token = created["token"].as_str().unwrap().to_string();

    let (status, rotated) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/backup-agents/{agent_id}/rotate-token"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, 200, "rotation failed: {rotated}");
    let new_token = rotated["token"].as_str().unwrap().to_string();
    assert_ne!(new_token, old_token);
    assert_eq!(rotated["agent"]["credentialActive"], true);

    // A missing run still distinguishes auth (404) from rejected auth (401).
    let probe = "/api/backup/v1/runs/22222222-2222-4222-8222-222222222222";
    let (status, _) = common::get_json(&h.app, probe, &old_token).await;
    assert_eq!(status, 401, "the previous credential stops working");
    let (status, _) = common::get_json(&h.app, probe, &new_token).await;
    assert_eq!(status, 404, "the replacement credential authenticates");

    let now = chrono::Utc::now();
    let run = h
        .state
        .backups
        .insert_run_metadata_at(&agent_id, valid_start("kept-run", now), now)
        .await
        .unwrap();

    let (status, revoked) = send(
        &h.app,
        request(
            "POST",
            &format!("/api/v1/backup-agents/{agent_id}/revoke-token"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, 200, "revocation failed: {revoked}");
    assert_eq!(revoked["agent"]["credentialActive"], false);

    let (status, _) = common::get_json(&h.app, probe, &new_token).await;
    assert_eq!(status, 401, "a revoked credential stops working");

    // History stays readable and the run remains attached to the agent.
    let (status, runs) = common::get_json(
        &h.app,
        &format!("/api/v1/backup-agents/{agent_id}/runs"),
        &h.token,
    )
    .await;
    assert_eq!(status, 200);
    let rows = runs["runs"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], run.id);
    assert_eq!(rows[0]["status"], "uploading");

    let (status, list) = common::get_json(&h.app, "/api/v1/backup-agents", &h.token).await;
    assert_eq!(status, 200);
    assert_eq!(list["agents"][0]["id"], agent_id);
    assert_eq!(list["agents"][0]["credentialActive"], false);
}

#[tokio::test]
async fn run_metadata_validates_time_and_limits() {
    let h = harness().await;
    let (_, created) = register_agent(&h, agent_body("meks", None)).await;
    let agent_id = created["agent"]["id"].as_str().unwrap().to_string();
    let now = chrono::Utc::now();

    let mut reversed = valid_start("reversed", now);
    reversed.export_started_at = (now - chrono::Duration::minutes(1)).to_rfc3339();
    reversed.export_finished_at = Some((now - chrono::Duration::minutes(2)).to_rfc3339());
    assert!(matches!(
        h.state
            .backups
            .insert_run_metadata_at(&agent_id, reversed, now)
            .await,
        Err(BackupError::BadRequest(_))
    ));

    let mut future = valid_start("future", now);
    future.export_finished_at = Some((now + chrono::Duration::minutes(10)).to_rfc3339());
    assert!(matches!(
        h.state
            .backups
            .insert_run_metadata_at(&agent_id, future, now)
            .await,
        Err(BackupError::BadRequest(_))
    ));

    let mut too_big = valid_start("too-big", now);
    too_big.total_bytes = Some(8 * 1024 * 1024 * 1024 + 1);
    assert!(matches!(
        h.state
            .backups
            .insert_run_metadata_at(&agent_id, too_big, now)
            .await,
        Err(BackupError::BadRequest(_))
    ));

    let mut bad_digest = valid_start("bad-digest", now);
    bad_digest.sha256 = Some(sha('A'));
    assert!(matches!(
        h.state
            .backups
            .insert_run_metadata_at(&agent_id, bad_digest, now)
            .await,
        Err(BackupError::BadRequest(_))
    ));

    let first = h
        .state
        .backups
        .insert_run_metadata_at(&agent_id, valid_start("same-id", now), now)
        .await
        .unwrap();
    let retried = h
        .state
        .backups
        .insert_run_metadata_at(&agent_id, valid_start("same-id", now), now)
        .await
        .unwrap();
    assert_eq!(first.id, retried.id, "an identical retry is idempotent");

    let mut conflicting = valid_start("same-id", now);
    conflicting.sha256 = Some(sha('c'));
    assert!(matches!(
        h.state
            .backups
            .insert_run_metadata_at(&agent_id, conflicting, now)
            .await,
        Err(BackupError::ParamsConflict(_))
    ));

    // Names are restricted; duplicates on one monitor are rejected.
    let monitor = create_monitor(&h, json!({ "name": "MEKS", "type": "push" })).await;
    let (status, _) = register_agent(&h, agent_body("meks", Some(monitor))).await;
    assert_eq!(status, 201);
    let (status, duplicate) = register_agent(&h, agent_body("meks", Some(monitor))).await;
    assert_eq!(status, 409, "duplicate linked name: {duplicate}");
    let (status, _) = register_agent(&h, agent_body("MEKS", Some(monitor))).await;
    assert_eq!(status, 400, "names are lowercase ASCII");
    let (status, _) = register_agent(&h, agent_body("-leading", Some(monitor))).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn backup_mutations_publish_invalidate() {
    use flatline_backend::backups::{storage::NoFaults, NewAgent};
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use std::time::Duration;

    struct FakeFreeSpace;
    impl flatline_backend::backups::storage::FreeSpace for FakeFreeSpace {
        fn available(&self, _root: &std::path::Path) -> std::io::Result<u64> {
            Ok(flatline_backend::backups::storage::RESERVE_BYTES + 64 * 1024 * 1024)
        }
    }

    let h = common::harness_with_backups(
        Arc::new(FakeFreeSpace),
        Arc::new(NoFaults),
    )
    .await;
    let mut events = h.state.events.subscribe();

    async fn expect_invalidate(
        events: &mut tokio::sync::broadcast::Receiver<serde_json::Value>,
    ) {
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("a backup mutation must publish an event")
            .expect("the event stream must stay open");
        assert_eq!(event["type"], "invalidate", "unexpected event: {event}");
    }

    let (agent, _) = h
        .state
        .backups
        .register_agent_at(
            NewAgent {
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
    expect_invalidate(&mut events).await;

    h.state
        .backups
        .patch_agent(
            &agent.id,
            flatline_backend::backups::AgentPatch {
                name: Some("meks-renamed".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    expect_invalidate(&mut events).await;

    h.state.backups.rotate_token(&agent.id).await.unwrap();
    expect_invalidate(&mut events).await;
    h.state.backups.revoke_token(&agent.id).await.unwrap();
    expect_invalidate(&mut events).await;

    let now = chrono::Utc::now();
    let data = b"chunk body".to_vec();
    let digest = hex::encode(Sha256::digest(&data));
    let run = h
        .state
        .backups
        .start_run_at(
            &agent.id,
            StartRun {
                client_run_id: "event-run".to_string(),
                export_started_at: (now - chrono::Duration::minutes(10)).to_rfc3339(),
                export_finished_at: Some(now.to_rfc3339()),
                total_bytes: Some(data.len() as i64),
                sha256: Some(digest.clone()),
                source_summary: None,
            },
            now,
        )
        .await
        .unwrap();
    expect_invalidate(&mut events).await;

    h.state
        .backups
        .put_chunk(
            &agent.id,
            &run.id,
            0,
            0,
            &digest,
            axum::body::Body::from(data),
        )
        .await
        .unwrap();
    expect_invalidate(&mut events).await;

    h.state
        .backups
        .complete_run(&agent.id, &run.id)
        .await
        .unwrap();
    expect_invalidate(&mut events).await;

    h.state
        .backups
        .verify_run(
            &run.id,
            "archive",
            "passed",
            &chrono::Utc::now().to_rfc3339(),
            "offline verify",
        )
        .await
        .unwrap();
    expect_invalidate(&mut events).await;

    // Health transitions persist and publish an invalidation.
    let (old, _) = h
        .state
        .backups
        .register_agent_at(
            NewAgent {
                name: "old".to_string(),
                monitor_id: None,
                enabled: true,
                interval_seconds: 86400,
                retention_count: 7,
            },
            now - chrono::Duration::hours(40),
        )
        .await
        .unwrap();
    expect_invalidate(&mut events).await;
    h.state
        .backups
        .evaluate_health(now.timestamp_millis())
        .await
        .unwrap();
    expect_invalidate(&mut events).await;
    let state: String = sqlx::query_scalar("SELECT alert_state FROM backup_agents WHERE id = ?")
        .bind(&old.id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(state, "overdue");
}

/// Review M1: a database error while checking an agent credential answered
/// 401, which the Go agent treats as a revoked token. It must be a
/// retryable 503 with Retry-After.
#[tokio::test]
async fn agent_auth_database_errors_are_retryable() {
    let h = common::harness().await;
    let (status, body) = register_agent(&h, agent_body("meks", None)).await;
    assert_eq!(status, 201, "{body}");
    let token = body["token"].as_str().unwrap().to_string();

    h.pool.close().await;
    let response = tower::ServiceExt::oneshot(
        h.app.clone(),
        common::request("GET", "/api/backup/v1/runs/unknown", Some(&token), None),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 503);
    assert!(
        response.headers().contains_key("retry-after"),
        "503 must tell the agent when to retry"
    );
}
