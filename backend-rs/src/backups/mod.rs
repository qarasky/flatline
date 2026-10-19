//! Named backup agents, their dedicated credentials and durable run history.
//!
//! Storage of bundle bytes lives in `storage` (receiver task); this module
//! owns identity, metadata and the state transitions that do not touch the
//! filesystem. Agent tokens are hashed with the same SHA-256 scheme as
//! operator tokens but live in their own table and authenticate only the
//! `/api/backup/v1` routes.

pub mod agents;
pub mod alerts;
pub mod maintenance;
pub mod runs;
pub mod storage;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use chrono::{DateTime, SecondsFormat, Utc};
use http_body_util::BodyExt;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tokio::sync::{Mutex, Semaphore};

use crate::auth::hash_token;
use crate::config::Config;
use crate::events::Events;
use runs::{ValidatedStart, Verification};
use storage::{
    CHUNK_BYTES, FaultInjector, FaultPoint, FreeSpace, NoFaults, RESERVE_BYTES, Storage,
    StorageError, SystemFreeSpace,
};

pub use runs::{RunSummary, StartRun};

/// Service error mapped to the HTTP contract by `api::backups`.
#[derive(Debug)]
pub enum Error {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    Unauthorized,
    Unavailable(String),
    Insufficient(String),
    TooLarge(String),
    HashMismatch(String),
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadRequest(message)
            | Error::NotFound(message)
            | Error::Conflict(message)
            | Error::Unavailable(message)
            | Error::Insufficient(message)
            | Error::TooLarge(message)
            | Error::HashMismatch(message)
            | Error::Internal(message) => formatter.write_str(message),
            Error::Unauthorized => formatter.write_str("Missing or invalid token."),
        }
    }
}

impl std::error::Error for Error {}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Error::Internal(error.to_string())
    }
}

fn default_true() -> bool {
    true
}

fn default_interval() -> i64 {
    86_400
}

fn default_retention() -> i64 {
    7
}

/// Registration input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgent {
    pub name: String,
    #[serde(default)]
    pub monitor_id: Option<i64>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_seconds: i64,
    #[serde(default = "default_retention")]
    pub retention_count: i64,
}

fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Patch input. `monitorId` distinguishes "absent" (None) from an explicit
/// null (Some(None)) so an agent can be unlinked.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub monitor_id: Option<Option<i64>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub interval_seconds: Option<i64>,
    #[serde(default)]
    pub retention_count: Option<i64>,
}

/// A completed bundle ready for streamed download.
pub struct BundleDownload {
    pub file: tokio::fs::File,
    pub length: u64,
    pub filename: String,
}

/// A failed export that may never have produced bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureReport {
    pub client_run_id: String,
    pub export_started_at: String,
    pub code: String,
}

/// The agent shape shared with the dashboard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub monitor_id: Option<i64>,
    pub enabled: bool,
    pub credential_active: bool,
    pub interval_seconds: i64,
    pub retention_count: i64,
    pub created_at: String,
    pub health: String,
    pub last_error_code: Option<String>,
    pub latest_run: Option<RunSummary>,
    pub last_completed_run: Option<RunSummary>,
    pub latest_archive_verification: Option<Verification>,
    pub latest_restore_verification: Option<Verification>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AgentRow {
    id: String,
    name: String,
    monitor_id: Option<i64>,
    enabled: i64,
    interval_seconds: i64,
    retention_count: i64,
    credential_active: i64,
    created_at: String,
    alert_state: String,
}

const AGENT_COLUMNS: &str = "id, name, monitor_id, enabled, interval_seconds, retention_count, \
                             credential_active, created_at, alert_state";

const RUN_COLUMNS: &str = "id, agent_id, client_run_id, status, export_started_at, \
                           export_finished_at, created_at, completed_at, total_bytes, \
                           received_bytes, sha256, source_summary, error_code, \
                           archive_verification, restore_verification";

#[derive(Debug, Clone, sqlx::FromRow)]
struct RunRow {
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
    source_summary: Option<String>,
    error_code: Option<String>,
    archive_verification: Option<String>,
    restore_verification: Option<String>,
}

impl From<RunRow> for RunSummary {
    fn from(row: RunRow) -> Self {
        Self {
            id: row.id,
            agent_id: row.agent_id,
            client_run_id: row.client_run_id,
            status: row.status,
            export_started_at: row.export_started_at,
            export_finished_at: row.export_finished_at,
            created_at: row.created_at,
            completed_at: row.completed_at,
            total_bytes: row.total_bytes,
            received_bytes: row.received_bytes,
            sha256: row.sha256,
            source_summary: row
                .source_summary
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok()),
            error_code: row.error_code,
            archive_verification: runs::parse_verification(row.archive_verification.as_deref()),
            restore_verification: runs::parse_verification(row.restore_verification.as_deref()),
        }
    }
}

/// Shared service, stored in `AppState`.
pub struct Backups {
    pool: SqlitePool,
    config: Arc<Config>,
    events: Arc<Events>,
    free: Arc<dyn FreeSpace>,
    faults: Arc<dyn FaultInjector>,
    /// Shared HTTP client for Telegram delivery through the existing
    /// notification links.
    client: reqwest::Client,
    /// Serializes capacity reservation with run insertion so two agents
    /// cannot both spend the same free space.
    reservation: Mutex<()>,
    /// At most four concurrent request-body readers.
    upload_slots: Semaphore,
    /// Last chunk-progress invalidation, coalesced to one per second.
    progress_event: std::sync::Mutex<Option<std::time::Instant>>,
    /// Serializes appends and finalization per run.
    run_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Backups {
    pub fn new(pool: SqlitePool, config: Arc<Config>, events: Arc<Events>) -> Arc<Self> {
        Self::with_io(
            pool,
            config,
            events,
            Arc::new(SystemFreeSpace),
            Arc::new(NoFaults),
        )
    }

    /// Test seam: deterministic free space and injectable crash points.
    pub fn with_io(
        pool: SqlitePool,
        config: Arc<Config>,
        events: Arc<Events>,
        free: Arc<dyn FreeSpace>,
        faults: Arc<dyn FaultInjector>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            config,
            events,
            free,
            faults,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            reservation: Mutex::new(()),
            upload_slots: Semaphore::new(4),
            progress_event: std::sync::Mutex::new(None),
            run_locks: Mutex::new(HashMap::new()),
        })
    }

    /// Configured storage root, when the operator enabled backups.
    pub fn backup_dir(&self) -> Option<&Path> {
        self.config.backup_dir.as_deref()
    }

    /// Start the production maintenance/health loop. Tests construct the
    /// service directly and never call this.
    pub fn start_jobs(self: &Arc<Self>) {
        let backups = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                ticker.tick().await;
                let now = Utc::now().timestamp_millis();
                if let Err(error) = backups.maintain(now).await {
                    tracing::error!("backup maintenance failed: {error}");
                }
                if let Err(error) = backups.evaluate_health(now).await {
                    tracing::error!("backup health evaluation failed: {error}");
                }
            }
        });
    }

    /// Open a completed bundle for streamed operator download. The file is
    /// not read into memory; the caller owns the stream.
    pub async fn open_bundle(&self, run_id: &str) -> Result<BundleDownload, Error> {
        let run = self.run_by_id(run_id).await?;
        if run.status != runs::STATUS_COMPLETED {
            return Err(Error::NotFound(
                "bundle is not a retained completed run".to_string(),
            ));
        }

        let storage = self.storage()?;
        let (path, length) = storage
            .final_metadata(&run.agent_id, &run.id)
            .map_err(storage_error)?;
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|error| Error::Internal(format!("storage: {error}")))?;

        Ok(BundleDownload {
            file,
            length,
            filename: format!("flatline-backup-{}.age", run.id),
        })
    }

    pub async fn register_agent(&self, input: NewAgent) -> Result<(AgentSummary, String), Error> {
        self.register_agent_at(input, Utc::now()).await
    }

    pub async fn register_agent_at(
        &self,
        input: NewAgent,
        now: DateTime<Utc>,
    ) -> Result<(AgentSummary, String), Error> {
        validate_settings(&input.name, input.interval_seconds, input.retention_count)?;

        if let Some(monitor_id) = input.monitor_id {
            self.require_monitor(monitor_id).await?;
            let duplicate: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM backup_agents WHERE monitor_id = ? AND name = ? LIMIT 1",
            )
            .bind(monitor_id)
            .bind(&input.name)
            .fetch_optional(&self.pool)
            .await?;
            if duplicate.is_some() {
                return Err(Error::Conflict(
                    "another agent with this name is linked to the monitor".to_string(),
                ));
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let token = agents::mint_token();
        let created_at = canonical(now);

        sqlx::query(
            "INSERT INTO backup_agents
                (id, name, monitor_id, enabled, interval_seconds, retention_count,
                 token_hash, credential_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(input.monitor_id)
        .bind(i64::from(input.enabled))
        .bind(input.interval_seconds)
        .bind(input.retention_count)
        .bind(hash_token(&token))
        .bind(&created_at)
        .execute(&self.pool)
        .await
        .map_err(|error| match error {
            sqlx::Error::Database(ref database) if database.is_unique_violation() => {
                Error::Conflict("another agent with this name is linked to the monitor".to_string())
            }
            other => Error::from(other),
        })?;

        let summary = self.agent_summary(&id, now.timestamp_millis()).await?;
        self.events.invalidate();
        Ok((summary, token))
    }

    pub async fn list_agents(
        &self,
        monitor_id: Option<i64>,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<(Vec<AgentSummary>, Option<String>), Error> {
        let limit = limit.clamp(1, 200);
        let cursor_row = match cursor {
            Some(id) => {
                let row: Option<(String,)> =
                    sqlx::query_as("SELECT created_at FROM backup_agents WHERE id = ?")
                        .bind(id)
                        .fetch_optional(&self.pool)
                        .await?;
                Some(row.ok_or_else(|| Error::BadRequest("unknown cursor".to_string()))?)
            }
            None => None,
        };

        let mut query = QueryBuilder::<Sqlite>::new(format!(
            "SELECT {AGENT_COLUMNS} FROM backup_agents WHERE 1 = 1"
        ));
        if let Some(monitor_id) = monitor_id {
            query.push(" AND monitor_id = ").push_bind(monitor_id);
        }
        if let Some((created_at,)) = &cursor_row {
            let created_at = created_at.as_str();
            query
                .push(" AND (created_at < ")
                .push_bind(created_at)
                .push(" OR (created_at = ")
                .push_bind(created_at)
                .push(" AND id < ")
                .push_bind(cursor.unwrap_or_default())
                .push("))");
        }
        query
            .push(" ORDER BY created_at DESC, id DESC LIMIT ")
            .push_bind(limit + 1);

        let mut rows: Vec<AgentRow> = query.build_query_as().fetch_all(&self.pool).await?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);

        let now = Utc::now().timestamp_millis();
        let mut agents = Vec::with_capacity(rows.len());
        for row in rows {
            agents.push(self.agent_summary_from_row(row, now).await?);
        }
        let next = if has_more {
            agents.last().map(|agent| agent.id.clone())
        } else {
            None
        };
        Ok((agents, next))
    }

    pub async fn patch_agent(&self, id: &str, patch: AgentPatch) -> Result<AgentSummary, Error> {
        let mut row = self.agent_row(id).await?;
        let mut changed = false;

        if let Some(name) = patch.name {
            row.name = name;
            changed = true;
        }
        if let Some(monitor_id) = patch.monitor_id {
            if let Some(monitor_id) = monitor_id {
                self.require_monitor(monitor_id).await?;
            }
            row.monitor_id = monitor_id;
            changed = true;
        }
        if let Some(enabled) = patch.enabled {
            row.enabled = i64::from(enabled);
            changed = true;
        }
        if let Some(interval_seconds) = patch.interval_seconds {
            row.interval_seconds = interval_seconds;
            changed = true;
        }
        if let Some(retention_count) = patch.retention_count {
            row.retention_count = retention_count;
            changed = true;
        }

        if !changed {
            return Err(Error::BadRequest("no settings supplied".to_string()));
        }
        validate_settings(&row.name, row.interval_seconds, row.retention_count)?;

        if let Some(monitor_id) = row.monitor_id {
            let duplicate: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM backup_agents
                  WHERE monitor_id = ? AND name = ? AND id <> ? LIMIT 1",
            )
            .bind(monitor_id)
            .bind(&row.name)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            if duplicate.is_some() {
                return Err(Error::Conflict(
                    "another agent with this name is linked to the monitor".to_string(),
                ));
            }
        }

        sqlx::query(
            "UPDATE backup_agents
                SET name = ?, monitor_id = ?, enabled = ?, interval_seconds = ?, retention_count = ?
              WHERE id = ?",
        )
        .bind(&row.name)
        .bind(row.monitor_id)
        .bind(row.enabled)
        .bind(row.interval_seconds)
        .bind(row.retention_count)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| match error {
            sqlx::Error::Database(ref database) if database.is_unique_violation() => {
                Error::Conflict("another agent with this name is linked to the monitor".to_string())
            }
            other => Error::from(other),
        })?;

        self.events.invalidate();
        self.agent_summary(id, Utc::now().timestamp_millis()).await
    }

    /// Replace the credential, returning the plaintext once.
    pub async fn rotate_token(&self, id: &str) -> Result<(AgentSummary, String), Error> {
        self.agent_row(id).await?;
        let token = agents::mint_token();
        sqlx::query("UPDATE backup_agents SET token_hash = ?, credential_active = 1 WHERE id = ?")
            .bind(hash_token(&token))
            .bind(id)
            .execute(&self.pool)
            .await?;

        self.events.invalidate();
        let summary = self
            .agent_summary(id, Utc::now().timestamp_millis())
            .await?;
        Ok((summary, token))
    }

    /// Revoke the credential while keeping the agent and its history.
    pub async fn revoke_token(&self, id: &str) -> Result<AgentSummary, Error> {
        self.agent_row(id).await?;
        sqlx::query(
            "UPDATE backup_agents SET token_hash = NULL, credential_active = 0 WHERE id = ?",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        self.events.invalidate();
        self.agent_summary(id, Utc::now().timestamp_millis()).await
    }

    pub async fn list_runs(
        &self,
        agent_id: &str,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<(Vec<RunSummary>, Option<String>), Error> {
        self.agent_row(agent_id).await?;
        let limit = limit.clamp(1, 200);

        let cursor_row = match cursor {
            Some(id) => {
                let row: Option<(String,)> = sqlx::query_as(
                    "SELECT created_at FROM backup_runs WHERE id = ? AND agent_id = ?",
                )
                .bind(id)
                .bind(agent_id)
                .fetch_optional(&self.pool)
                .await?;
                Some(row.ok_or_else(|| Error::BadRequest("unknown cursor".to_string()))?)
            }
            None => None,
        };

        let mut query = QueryBuilder::<Sqlite>::new(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs WHERE agent_id = "
        ));
        query.push_bind(agent_id);
        if let Some((created_at,)) = &cursor_row {
            let created_at = created_at.as_str();
            query
                .push(" AND (created_at < ")
                .push_bind(created_at)
                .push(" OR (created_at = ")
                .push_bind(created_at)
                .push(" AND id < ")
                .push_bind(cursor.unwrap_or_default())
                .push("))");
        }
        query
            .push(" ORDER BY created_at DESC, id DESC LIMIT ")
            .push_bind(limit + 1);

        let mut rows: Vec<RunRow> = query.build_query_as().fetch_all(&self.pool).await?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);

        let next = if has_more {
            rows.last().map(|row| row.id.clone())
        } else {
            None
        };
        Ok((rows.into_iter().map(RunSummary::from).collect(), next))
    }

    /// A run owned by this agent; another agent's run is indistinguishable
    /// from a missing one.
    pub async fn run_for_agent(&self, agent_id: &str, run_id: &str) -> Result<RunSummary, Error> {
        let row: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs WHERE id = ? AND agent_id = ?"
        )))
        .bind(run_id)
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(RunSummary::from)
            .ok_or_else(|| Error::NotFound("run not found".to_string()))
    }

    /// Create the metadata row without touching storage. Failure reports
    /// and tests use this; upload starts reserve capacity through
    /// [`Self::start_run_at`].
    pub async fn insert_run_metadata_at(
        &self,
        agent_id: &str,
        input: StartRun,
        now: DateTime<Utc>,
    ) -> Result<RunSummary, Error> {
        let validated = input.validate(now)?;
        self.agent_row(agent_id).await?;

        if let Some(existing) = self
            .run_by_client_id(agent_id, &validated.client_run_id)
            .await?
        {
            if !same_start(&existing, &validated) {
                return Err(Error::Conflict(
                    "clientRunId was already used with different parameters".to_string(),
                ));
            }
            return Ok(existing);
        }

        let active: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM backup_runs
              WHERE agent_id = ? AND status IN ('uploading', 'finalizing') LIMIT 1",
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await?;
        if active.is_some() {
            return Err(Error::Conflict(
                "another run is currently uploading".to_string(),
            ));
        }

        let id = uuid::Uuid::new_v4().to_string();
        insert_run(&self.pool, &id, agent_id, &validated, now).await?;
        self.events.invalidate();
        self.run_by_id(&id).await
    }

    pub async fn start_run(&self, agent_id: &str, input: StartRun) -> Result<RunSummary, Error> {
        self.start_run_at(agent_id, input, Utc::now()).await
    }

    /// Start an upload, reserving the whole declared bundle against free
    /// space before any bytes are accepted. An identical retry returns the
    /// existing run and its committed offset; an expired run with identical
    /// parameters is reopened at zero after its old bytes are removed.
    pub async fn start_run_at(
        &self,
        agent_id: &str,
        input: StartRun,
        now: DateTime<Utc>,
    ) -> Result<RunSummary, Error> {
        let validated = input.validate(now)?;
        self.agent_row(agent_id).await?;
        let storage = self.storage()?;

        let _reservation = self.reservation.lock().await;

        if let Some(existing) = self
            .run_by_client_id(agent_id, &validated.client_run_id)
            .await?
        {
            if !same_start(&existing, &validated) {
                return Err(Error::Conflict(
                    "clientRunId was already used with different parameters".to_string(),
                ));
            }
            let status = existing.status.clone();
            match status.as_str() {
                runs::STATUS_UPLOADING | runs::STATUS_FINALIZING | runs::STATUS_COMPLETED => {
                    return Ok(existing);
                }
                runs::STATUS_EXPIRED => {
                    storage
                        .delete_run(agent_id, &existing.id)
                        .map_err(storage_error)?;
                    sqlx::query("DELETE FROM backup_run_chunks WHERE run_id = ?")
                        .bind(&existing.id)
                        .execute(&self.pool)
                        .await?;
                    self.reserve_capacity(&storage, validated.total_bytes)
                        .await?;
                    sqlx::query(
                        "UPDATE backup_runs
                            SET status = 'uploading', received_bytes = 0, completed_at = NULL,
                                error_code = NULL, archive_verification = NULL,
                                restore_verification = NULL, last_activity_at = ?
                          WHERE id = ?",
                    )
                    .bind(canonical(now))
                    .bind(&existing.id)
                    .execute(&self.pool)
                    .await?;
                    storage
                        .prepare_run(agent_id, &existing.id)
                        .map_err(storage_error)?;
                    self.events.invalidate();
                    return self.run_by_id(&existing.id).await;
                }
                _ => {
                    return Err(Error::Conflict(
                        "this run can no longer be reopened".to_string(),
                    ));
                }
            }
        }

        let active: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM backup_runs
              WHERE agent_id = ? AND status IN ('uploading', 'finalizing') LIMIT 1",
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await?;
        if active.is_some() {
            return Err(Error::Conflict(
                "another run is currently uploading".to_string(),
            ));
        }

        self.reserve_capacity(&storage, validated.total_bytes)
            .await?;

        let id = uuid::Uuid::new_v4().to_string();
        insert_run(&self.pool, &id, agent_id, &validated, now).await?;
        if let Err(error) = storage.prepare_run(agent_id, &id) {
            let _ = sqlx::query("DELETE FROM backup_runs WHERE id = ?")
                .bind(&id)
                .execute(&self.pool)
                .await;
            return Err(storage_error(error));
        }

        self.events.invalidate();
        self.run_by_id(&id).await
    }

    /// Append one chunk after verifying its digest, then advance the
    /// committed offset. A failed response is safely retryable.
    pub async fn put_chunk(
        &self,
        agent_id: &str,
        run_id: &str,
        index: u64,
        offset: u64,
        sha256: &str,
        body: Body,
    ) -> Result<RunSummary, Error> {
        if !runs::valid_sha256(sha256) {
            return Err(Error::BadRequest(
                "X-Backup-Sha256 must be 64 lowercase hexadecimal characters".to_string(),
            ));
        }

        // Verify ownership before creating a per-run lock, so unknown ids
        // cannot grow the lock map. Then serialize the whole body read for
        // this run; at most four run bodies are in memory at once.
        let owned = self.run_for_agent(agent_id, run_id).await?;
        let run_lock = self.run_lock(&owned.id).await;
        let _run = run_lock.lock().await;
        let _slot = self
            .upload_slots
            .acquire()
            .await
            .map_err(|_| Error::Internal("upload limiter closed".to_string()))?;
        let bytes = read_bounded(body, CHUNK_BYTES as usize).await?;
        let digest = hex::encode(Sha256::digest(&bytes));

        if digest != sha256 {
            return Err(Error::HashMismatch(
                "chunk sha256 does not match the request body".to_string(),
            ));
        }

        let run = self.run_for_agent(agent_id, run_id).await?;

        let total = run
            .total_bytes
            .ok_or_else(|| Error::Conflict("run has no declared size".to_string()))?
            as u64;
        let committed = run.received_bytes as u64;

        if index != offset / CHUNK_BYTES {
            return Err(Error::BadRequest(
                "chunk index must be offset / 8388608".to_string(),
            ));
        }

        if offset < committed {
            let stored = self.chunk_row(run_id, index).await?;
            return match stored {
                Some((stored_offset, stored_size, stored_sha))
                    if stored_offset == offset as i64
                        && stored_size == bytes.len() as i64
                        && stored_sha == sha256 =>
                {
                    Ok(run)
                }
                _ => Err(Error::Conflict(
                    "chunk conflicts with the committed ledger".to_string(),
                )),
            };
        }

        if run.status != runs::STATUS_UPLOADING {
            return Err(Error::Conflict("run is not accepting chunks".to_string()));
        }
        if offset != committed {
            return Err(Error::Conflict(format!(
                "expected offset {committed}, received {offset}"
            )));
        }

        let length = bytes.len() as u64;
        if length == 0 {
            return Err(Error::BadRequest(
                "empty chunks are not accepted".to_string(),
            ));
        }
        if offset.saturating_add(length) > total {
            return Err(Error::TooLarge(
                "chunk exceeds the declared bundle size".to_string(),
            ));
        }
        if offset + length < total && length != CHUNK_BYTES {
            return Err(Error::BadRequest(
                "non-final chunks must be exactly 8388608 bytes".to_string(),
            ));
        }

        let storage = self.storage()?;
        let free = storage.available_bytes().map_err(storage_error)?;
        if free < length.saturating_add(RESERVE_BYTES) {
            return Err(Error::Insufficient(
                "office storage reserve would be violated".to_string(),
            ));
        }

        storage
            .append_chunk(agent_id, run_id, offset, &bytes)
            .map_err(storage_error)?;

        let next = offset + length;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO backup_run_chunks (run_id, chunk_index, offset, size, sha256)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(run_id)
        .bind(index as i64)
        .bind(offset as i64)
        .bind(length as i64)
        .bind(sha256)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE backup_runs SET received_bytes = ?, last_activity_at = ? WHERE id = ?")
            .bind(next as i64)
            .bind(canonical(Utc::now()))
            .bind(run_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;

        self.faults
            .hit(FaultPoint::AfterDbUpdate)
            .map_err(|error| Error::Internal(format!("storage: {error}")))?;
        self.invalidate_progress();
        self.run_by_id(run_id).await
    }

    /// Finalize idempotently: check the full digest, publish atomically and
    /// only then mark the run completed.
    pub async fn complete_run(&self, agent_id: &str, run_id: &str) -> Result<RunSummary, Error> {
        let run_lock = self.run_lock(run_id).await;
        let _run = run_lock.lock().await;
        let run = self.run_for_agent(agent_id, run_id).await?;

        if run.status == runs::STATUS_COMPLETED {
            return Ok(run);
        }
        if run.status != runs::STATUS_UPLOADING && run.status != runs::STATUS_FINALIZING {
            return Err(Error::Conflict("run cannot be completed".to_string()));
        }

        let total = run
            .total_bytes
            .ok_or_else(|| Error::Conflict("run has no declared size".to_string()))?;
        if run.received_bytes != total {
            return Err(Error::Conflict(format!(
                "received {} of {total} bytes",
                run.received_bytes
            )));
        }
        let sha256 = run
            .sha256
            .clone()
            .ok_or_else(|| Error::Conflict("run has no declared digest".to_string()))?;

        let storage = self.storage()?;
        if run.status == runs::STATUS_UPLOADING {
            sqlx::query("UPDATE backup_runs SET status = 'finalizing' WHERE id = ?")
                .bind(run_id)
                .execute(&self.pool)
                .await?;
        }

        match storage.finalize(agent_id, run_id, total as u64, &sha256) {
            Ok(()) => {}
            Err(StorageError::Mismatch(message)) => {
                self.fail_run(run_id, "bundle_hash_mismatch").await?;
                return Err(Error::HashMismatch(message));
            }
            Err(error) => return Err(storage_error(error)),
        }

        sqlx::query(
            "UPDATE backup_runs SET status = 'completed', completed_at = ?,
                    error_code = NULL, last_activity_at = ? WHERE id = ?",
        )
        .bind(canonical(Utc::now()))
        .bind(canonical(Utc::now()))
        .bind(run_id)
        .execute(&self.pool)
        .await?;

        self.events.invalidate();
        self.run_by_id(run_id).await
    }

    /// Finish interrupted uploads and finalizations. Runs before maintenance
    /// in production; safe to call repeatedly.
    pub async fn reconcile_storage(&self) -> Result<(), Error> {
        let rows: Vec<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs
              WHERE status IN ('uploading', 'finalizing')"
        )))
        .fetch_all(&self.pool)
        .await?;

        if rows.is_empty() {
            return Ok(());
        }
        // Storage being disabled must never take monitoring down; leave the
        // rows for maintenance once an operator provisions the root.
        let storage = match self.storage() {
            Ok(storage) => storage,
            Err(Error::Unavailable(message)) => {
                tracing::warn!("backup reconciliation deferred: {message}");
                return Ok(());
            }
            Err(error) => return Err(error),
        };

        for row in rows {
            match row.status.as_str() {
                runs::STATUS_UPLOADING => {
                    match storage.truncate_to_committed(
                        &row.agent_id,
                        &row.id,
                        row.received_bytes as u64,
                    ) {
                        Ok(()) => {}
                        Err(StorageError::Io(error))
                            if error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            self.fail_run(&row.id, "bundle_missing").await?;
                        }
                        Err(error) => {
                            tracing::error!("backup reconcile: run {}: {error}", row.id);
                            self.fail_run(&row.id, "storage_reconcile_failed").await?;
                        }
                    }
                }
                runs::STATUS_FINALIZING => {
                    if let Err(error) = self.reconcile_finalizing(&storage, &row).await {
                        tracing::error!("backup reconcile: run {}: {error}", row.id);
                        self.fail_run(&row.id, "storage_reconcile_failed").await?;
                    }
                }
                _ => {}
            }
        }

        Ok(())
    }

    async fn reconcile_finalizing(&self, storage: &Storage, row: &RunRow) -> Result<(), Error> {
        let total = row.total_bytes.unwrap_or_default() as u64;
        let sha256 = row.sha256.clone().unwrap_or_default();
        let final_path = storage
            .final_path(&row.agent_id, &row.id)
            .map_err(storage_error)?;

        if final_path.exists() {
            storage
                .verify_final(&row.agent_id, &row.id, total, &sha256)
                .map_err(storage_error)?;
        } else {
            storage
                .finalize(&row.agent_id, &row.id, total, &sha256)
                .map_err(storage_error)?;
        }

        sqlx::query(
            "UPDATE backup_runs SET status = 'completed', completed_at = ?,
                    error_code = NULL WHERE id = ?",
        )
        .bind(canonical(Utc::now()))
        .bind(&row.id)
        .execute(&self.pool)
        .await?;
        self.events.invalidate();
        Ok(())
    }

    /// Report a failed export that may never have produced bytes. Safe error
    /// codes only; stderr never reaches the API.
    pub async fn report_failure(
        &self,
        agent_id: &str,
        input: FailureReport,
    ) -> Result<RunSummary, Error> {
        self.agent_row(agent_id).await?;
        if !runs::valid_failure_code(&input.code) {
            return Err(Error::BadRequest("unknown failure code".to_string()));
        }
        let started = DateTime::parse_from_rfc3339(&input.export_started_at)
            .map_err(|_| Error::BadRequest("exportStartedAt must be RFC3339".to_string()))?
            .with_timezone(&Utc);
        if started.timestamp_millis() > Utc::now().timestamp_millis() + runs::FUTURE_TOLERANCE_MS {
            return Err(Error::BadRequest(
                "exportStartedAt must not be in the future".to_string(),
            ));
        }

        if let Some(existing) = self
            .run_by_client_id(agent_id, &input.client_run_id)
            .await?
        {
            if existing.status == runs::STATUS_COMPLETED {
                return Err(Error::Conflict(
                    "a completed run cannot be failed".to_string(),
                ));
            }
            if existing.status == runs::STATUS_FAILED {
                if existing.error_code.as_deref() == Some(input.code.as_str()) {
                    return Ok(existing);
                }
                return Err(Error::Conflict(
                    "clientRunId was already reported with a different code".to_string(),
                ));
            }

            sqlx::query("UPDATE backup_runs SET status = 'failed', error_code = ? WHERE id = ?")
                .bind(&input.code)
                .bind(&existing.id)
                .execute(&self.pool)
                .await?;
            self.events.invalidate();
            return self.run_by_id(&existing.id).await;
        }

        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO backup_runs
                (id, agent_id, client_run_id, status, export_started_at, created_at,
                 received_bytes, error_code, last_activity_at)
             VALUES (?, ?, ?, 'failed', ?, ?, 0, ?, ?)",
        )
        .bind(&id)
        .bind(agent_id)
        .bind(&input.client_run_id)
        .bind(canonical(started))
        .bind(canonical(Utc::now()))
        .bind(&input.code)
        .bind(canonical(Utc::now()))
        .execute(&self.pool)
        .await?;

        self.events.invalidate();
        self.run_by_id(&id).await
    }

    async fn reserve_capacity(&self, storage: &Storage, new_total: i64) -> Result<(), Error> {
        let free = storage.available_bytes().map_err(storage_error)?;
        let reserved: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(total_bytes - received_bytes), 0)
               FROM backup_runs
              WHERE status IN ('uploading', 'finalizing')",
        )
        .fetch_one(&self.pool)
        .await?;

        let headroom = i128::from(free) - i128::from(reserved.max(0)) - i128::from(new_total);
        if headroom < i128::from(RESERVE_BYTES) {
            return Err(Error::Insufficient(format!(
                "office storage reserve of {RESERVE_BYTES} bytes would be violated"
            )));
        }
        Ok(())
    }

    fn storage(&self) -> Result<Storage, Error> {
        let Some(root) = self.config.backup_dir.as_deref() else {
            return Err(Error::Unavailable(
                "backup storage is not configured".to_string(),
            ));
        };
        let storage = Storage::open_with(root, Arc::clone(&self.free), Arc::clone(&self.faults))
            .map_err(storage_error)?;
        pin_storage_marker(&self.config.data_dir, storage.provisioned_id())?;
        Ok(storage)
    }

    fn invalidate_progress(&self) {
        let now = std::time::Instant::now();
        let mut last = self.progress_event.lock().unwrap();
        let due =
            last.is_none_or(|last| now.duration_since(last) >= std::time::Duration::from_secs(1));
        if due {
            *last = Some(now);
            drop(last);
            self.events.invalidate();
        }
    }

    async fn run_lock(&self, run_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.run_locks.lock().await;
        Arc::clone(
            locks
                .entry(run_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    async fn chunk_row(
        &self,
        run_id: &str,
        index: u64,
    ) -> Result<Option<(i64, i64, String)>, Error> {
        Ok(sqlx::query_as(
            "SELECT offset, size, sha256 FROM backup_run_chunks
              WHERE run_id = ? AND chunk_index = ?",
        )
        .bind(run_id)
        .bind(index as i64)
        .fetch_optional(&self.pool)
        .await?)
    }

    async fn fail_run(&self, run_id: &str, code: &str) -> Result<(), Error> {
        sqlx::query("UPDATE backup_runs SET status = 'failed', error_code = ? WHERE id = ?")
            .bind(code)
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        self.events.invalidate();
        Ok(())
    }

    /// Record an operator verification. Archive and restore are distinct
    /// states and only completed runs can be verified.
    pub async fn verify_run(
        &self,
        run_id: &str,
        kind: &str,
        status: &str,
        checked_at: &str,
        summary: &str,
    ) -> Result<RunSummary, Error> {
        if kind != "archive" && kind != "restore" {
            return Err(Error::BadRequest(
                "kind must be archive or restore".to_string(),
            ));
        }
        if status != "passed" && status != "failed" {
            return Err(Error::BadRequest(
                "status must be passed or failed".to_string(),
            ));
        }
        if summary.len() > runs::MAX_VERIFICATION_SUMMARY {
            return Err(Error::BadRequest(
                "summary must be at most 2 KiB".to_string(),
            ));
        }
        let checked = DateTime::parse_from_rfc3339(checked_at)
            .map_err(|_| Error::BadRequest("checkedAt must be RFC3339".to_string()))?
            .with_timezone(&Utc);
        if checked.timestamp_millis() > Utc::now().timestamp_millis() + runs::FUTURE_TOLERANCE_MS {
            return Err(Error::BadRequest(
                "checkedAt must not be in the future".to_string(),
            ));
        }

        let run = self.run_by_id(run_id).await?;
        if run.status != runs::STATUS_COMPLETED {
            return Err(Error::Conflict(
                "only completed runs can be verified".to_string(),
            ));
        }

        let verification = Verification {
            run_id: run_id.to_string(),
            status: status.to_string(),
            checked_at: canonical(checked),
            summary: summary.to_string(),
        };
        let encoded = serde_json::to_string(&verification)
            .map_err(|error| Error::Internal(error.to_string()))?;
        let column = if kind == "archive" {
            "archive_verification"
        } else {
            "restore_verification"
        };

        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE backup_runs SET {column} = ? WHERE id = ?"
        )))
        .bind(encoded)
        .bind(run_id)
        .execute(&self.pool)
        .await?;

        self.events.invalidate();
        self.run_by_id(run_id).await
    }

    async fn require_monitor(&self, monitor_id: i64) -> Result<(), Error> {
        let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM monitors WHERE id = ?")
            .bind(monitor_id)
            .fetch_optional(&self.pool)
            .await?;
        found
            .map(|_| ())
            .ok_or_else(|| Error::NotFound("monitor not found".to_string()))
    }

    async fn agent_row(&self, id: &str) -> Result<AgentRow, Error> {
        let row: Option<AgentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {AGENT_COLUMNS} FROM backup_agents WHERE id = ?"
        )))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.ok_or_else(|| Error::NotFound("agent not found".to_string()))
    }

    async fn run_by_id(&self, id: &str) -> Result<RunSummary, Error> {
        let row: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs WHERE id = ?"
        )))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(RunSummary::from)
            .ok_or_else(|| Error::NotFound("run not found".to_string()))
    }

    async fn run_by_client_id(
        &self,
        agent_id: &str,
        client_run_id: &str,
    ) -> Result<Option<RunSummary>, Error> {
        let row: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs WHERE agent_id = ? AND client_run_id = ?"
        )))
        .bind(agent_id)
        .bind(client_run_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(RunSummary::from))
    }

    async fn agent_summary(&self, id: &str, now_ms: i64) -> Result<AgentSummary, Error> {
        let row = self.agent_row(id).await?;
        self.agent_summary_from_row(row, now_ms).await
    }

    async fn agent_summary_from_row(
        &self,
        row: AgentRow,
        now_ms: i64,
    ) -> Result<AgentSummary, Error> {
        let latest: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs
              WHERE agent_id = ?
              ORDER BY COALESCE(export_finished_at, export_started_at, created_at) DESC, id DESC
              LIMIT 1"
        )))
        .bind(&row.id)
        .fetch_optional(&self.pool)
        .await?;

        let last_completed: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs
              WHERE agent_id = ? AND status = 'completed'
              ORDER BY COALESCE(export_finished_at, completed_at, created_at) DESC, id DESC
              LIMIT 1"
        )))
        .bind(&row.id)
        .fetch_optional(&self.pool)
        .await?;

        let archive: Option<(String,)> = sqlx::query_as(
            "SELECT archive_verification FROM backup_runs
              WHERE agent_id = ? AND archive_verification IS NOT NULL
              ORDER BY json_extract(archive_verification, '$.checkedAt') DESC, created_at DESC
              LIMIT 1",
        )
        .bind(&row.id)
        .fetch_optional(&self.pool)
        .await?;
        let restore: Option<(String,)> = sqlx::query_as(
            "SELECT restore_verification FROM backup_runs
              WHERE agent_id = ? AND restore_verification IS NOT NULL
              ORDER BY json_extract(restore_verification, '$.checkedAt') DESC, created_at DESC
              LIMIT 1",
        )
        .bind(&row.id)
        .fetch_optional(&self.pool)
        .await?;

        let latest_run = latest.map(RunSummary::from);
        let last_completed_run = last_completed.map(RunSummary::from);
        let health = runs::health_for(
            row.enabled != 0,
            &row.created_at,
            latest_run.as_ref(),
            last_completed_run.as_ref(),
            now_ms,
        );
        let last_error_code = latest_run.as_ref().and_then(|run| run.error_code.clone());

        Ok(AgentSummary {
            id: row.id,
            name: row.name,
            monitor_id: row.monitor_id,
            enabled: row.enabled != 0,
            credential_active: row.credential_active != 0,
            interval_seconds: row.interval_seconds,
            retention_count: row.retention_count,
            created_at: row.created_at,
            health: health.to_string(),
            last_error_code,
            latest_run,
            last_completed_run,
            latest_archive_verification: runs::parse_verification(
                archive.as_ref().map(|(value,)| value.as_str()),
            ),
            latest_restore_verification: runs::parse_verification(
                restore.as_ref().map(|(value,)| value.as_str()),
            ),
        })
    }
}

async fn read_bounded(mut body: Body, max: usize) -> Result<Vec<u8>, Error> {
    let mut data = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| Error::BadRequest("invalid request body".to_string()))?;
        if let Ok(chunk) = frame.into_data() {
            if data.len() + chunk.len() > max {
                return Err(Error::TooLarge(format!(
                    "chunk exceeds the {max}-byte limit"
                )));
            }
            data.extend_from_slice(&chunk);
        }
    }
    Ok(data)
}

/// The marker UUID is pinned in the application data directory on first use,
/// so replacing the mount with a different provisioned tree is refused across
/// restarts, not just within one process.
fn pin_storage_marker(data_dir: &Path, marker: &str) -> Result<(), Error> {
    let path = data_dir.join("backup-storage-id");
    match std::fs::read_to_string(&path) {
        Ok(existing) => {
            if existing.trim() != marker {
                return Err(Error::Unavailable(
                    "backup storage marker does not match the provisioned storage".to_string(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::write(&path, format!("{marker}\n"))
                .map_err(|error| Error::Internal(format!("pin backup storage marker: {error}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
        Err(error) => {
            return Err(Error::Internal(format!("read backup storage pin: {error}")));
        }
    }
    Ok(())
}

fn storage_error(error: StorageError) -> Error {
    match error {
        StorageError::Unavailable(message) => Error::Unavailable(message),
        StorageError::Mismatch(message) => Error::HashMismatch(message),
        StorageError::Io(error) => Error::Internal(format!("storage: {error}")),
    }
}

fn validate_settings(name: &str, interval_seconds: i64, retention_count: i64) -> Result<(), Error> {
    if !agents::valid_name(name) {
        return Err(Error::BadRequest(
            "name must be lowercase ASCII letters, digits, hyphens or underscores (1-64, \
             starting with a letter or digit)"
                .to_string(),
        ));
    }
    if interval_seconds <= 0 {
        return Err(Error::BadRequest(
            "intervalSeconds must be positive".to_string(),
        ));
    }
    if !(1..=30).contains(&retention_count) {
        return Err(Error::BadRequest(
            "retentionCount must be between 1 and 30".to_string(),
        ));
    }
    Ok(())
}

fn canonical(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn same_start(existing: &RunSummary, validated: &ValidatedStart) -> bool {
    let same_summary = match (&existing.source_summary, &validated.source_summary) {
        (None, None) => true,
        (Some(existing), Some(validated)) => {
            serde_json::from_str::<Value>(validated).ok().as_ref() == Some(existing)
        }
        _ => false,
    };

    existing.client_run_id == validated.client_run_id
        && existing.export_started_at == validated.export_started_at
        && existing.export_finished_at.as_deref() == Some(validated.export_finished_at.as_str())
        && existing.total_bytes == Some(validated.total_bytes)
        && existing.sha256.as_deref() == Some(validated.sha256.as_str())
        && same_summary
}

async fn insert_run(
    pool: &SqlitePool,
    id: &str,
    agent_id: &str,
    validated: &ValidatedStart,
    now: DateTime<Utc>,
) -> Result<(), Error> {
    sqlx::query(
        "INSERT INTO backup_runs
            (id, agent_id, client_run_id, status, export_started_at, export_finished_at,
             created_at, total_bytes, received_bytes, sha256, source_summary, last_activity_at)
         VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(id)
    .bind(agent_id)
    .bind(&validated.client_run_id)
    .bind(&validated.export_started_at)
    .bind(&validated.export_finished_at)
    .bind(canonical(now))
    .bind(validated.total_bytes)
    .bind(&validated.sha256)
    .bind(&validated.source_summary)
    .bind(canonical(now))
    .execute(pool)
    .await
    .map_err(|error| match error {
        sqlx::Error::Database(ref database) if database.is_unique_violation() => {
            Error::Conflict("clientRunId already exists".to_string())
        }
        other => Error::from(other),
    })?;
    Ok(())
}
