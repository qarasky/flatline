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
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use axum::body::Body;
use chrono::{DateTime, SecondsFormat, Utc};
use http_body_util::BodyExt;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::auth::hash_token;
use crate::config::Config;
use crate::events::Events;
use runs::{ValidatedStart, Verification};
use storage::{
    CHUNK_BYTES, FaultInjector, FaultPoint, FreeSpace, NoFaults, RESERVE_BYTES, Storage,
    StorageError, SystemFreeSpace, run_blocking,
};

pub use runs::{RunSummary, StartRun};

/// Service error mapped to the HTTP contract by `api::backups`.
#[derive(Debug)]
pub enum Error {
    BadRequest(String),
    NotFound(String),
    /// A generic, retryable conflict (chunk ledger, offset, race).
    Conflict(String),
    /// Another run of this agent is uploading or finalizing. Carries its
    /// identity so the agent can resume it (same clientRunId) or abandon it.
    ActiveRun {
        run_id: String,
        client_run_id: String,
    },
    /// The clientRunId exists with different start parameters; this bundle
    /// can never be delivered under that id.
    ParamsConflict(String),
    /// The run is in a terminal state and cannot be reopened or completed.
    Terminal(String),
    Unauthorized,
    Unavailable(String),
    Insufficient(String),
    TooLarge(String),
    HashMismatch(String),
    /// Transient contention (upload slots, per-run lock): retry later.
    Busy(String),
    /// The client stopped sending a request body in time.
    Timeout(String),
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadRequest(message)
            | Error::NotFound(message)
            | Error::Conflict(message)
            | Error::ParamsConflict(message)
            | Error::Terminal(message)
            | Error::Unavailable(message)
            | Error::Insufficient(message)
            | Error::TooLarge(message)
            | Error::HashMismatch(message)
            | Error::Busy(message)
            | Error::Timeout(message)
            | Error::Internal(message) => formatter.write_str(message),
            Error::Unauthorized => formatter.write_str("Missing or invalid token."),
            Error::ActiveRun { run_id, .. } => {
                write!(formatter, "run {run_id} of this agent is still uploading")
            }
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

/// A short-lived, single-use download ticket returned to an operator.
#[derive(Debug, Clone)]
pub struct DownloadTicket {
    pub ticket: String,
    pub run_id: String,
    pub expires_at: DateTime<Utc>,
}

/// Default lifetime of a download ticket.
pub const DOWNLOAD_TICKET_TTL: Duration = Duration::from_secs(120);

/// Outstanding tickets are bounded; issuing more answers 503 busy.
const MAX_DOWNLOAD_TICKETS: usize = 64;

struct TicketEntry {
    run_id: String,
    expires: std::time::Instant,
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
    /// Version the agent last reported running; NULL before any report.
    pub reported_version: Option<String>,
    pub version_reported_at: Option<String>,
    /// Outcome of the host's last self-update attempt (`ok` or a code).
    pub update_status: Option<String>,
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
    reported_version: Option<String>,
    version_reported_at: Option<String>,
    update_status: Option<String>,
}

const AGENT_COLUMNS: &str = "id, name, monitor_id, enabled, interval_seconds, retention_count, \
                             credential_active, created_at, alert_state, reported_version, \
                             version_reported_at, update_status";

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

/// Bounds on one chunk upload. A half-open connection must release its
/// upload slot and the run lock instead of holding them forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadLimits {
    /// Longest wait for one of the four body-reader slots.
    pub slot_wait: Duration,
    /// Longest wait for the per-run append/finalize lock.
    pub lock_wait: Duration,
    /// Longest silence between two body frames.
    pub body_idle: Duration,
    /// Longest time to receive one whole chunk body.
    pub body_total: Duration,
}

impl Default for UploadLimits {
    fn default() -> Self {
        Self {
            slot_wait: Duration::from_secs(30),
            lock_wait: Duration::from_secs(30),
            body_idle: Duration::from_secs(30),
            // The Go agent's own request deadline is two minutes.
            body_total: Duration::from_secs(5 * 60),
        }
    }
}

type RunLockMap = Arc<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>>;

/// One reference to a per-run lock entry. Dropping the last reference
/// removes the entry, so the map holds only runs with work in flight.
struct RunLockEntry {
    key: String,
    map: RunLockMap,
    entry: Option<Arc<Mutex<()>>>,
}

impl Drop for RunLockEntry {
    fn drop(&mut self) {
        // Clones are only made under the map lock, so the count is stable
        // while it is held.
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        drop(self.entry.take());
        if map
            .get(&self.key)
            .is_some_and(|entry| Arc::strong_count(entry) == 1)
        {
            map.remove(&self.key);
        }
    }
}

/// Held per-run lock. Field order matters: the mutex guard is released
/// before the entry reference is pruned.
struct RunLockGuard {
    _guard: OwnedMutexGuard<()>,
    _entry: RunLockEntry,
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
    /// Serializes appends and finalization per run. Entries exist only
    /// while a request holds or awaits them.
    run_locks: RunLockMap,
    /// Upload timeouts; adjustable for tests.
    limits: std::sync::Mutex<UploadLimits>,
    /// Cancelled at shutdown: stops the maintenance loop and aborts body
    /// reads that are still waiting on the network.
    shutdown: CancellationToken,
    /// Download tickets keyed by the SHA-256 of the ticket; in memory only,
    /// so a restart invalidates every outstanding ticket.
    tickets: std::sync::Mutex<HashMap<String, TicketEntry>>,
    ticket_ttl: std::sync::Mutex<Duration>,
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
            run_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
            limits: std::sync::Mutex::new(UploadLimits::default()),
            shutdown: CancellationToken::new(),
            tickets: std::sync::Mutex::new(HashMap::new()),
            ticket_ttl: std::sync::Mutex::new(DOWNLOAD_TICKET_TTL),
        })
    }

    /// Replace the ticket lifetime (tests use a short one).
    pub fn set_download_ticket_ttl(&self, ttl: Duration) {
        *self
            .ticket_ttl
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = ttl;
    }

    /// Issue a single-use ticket for one completed run. The browser can then
    /// stream the bundle with a plain GET (no Authorization header, no
    /// buffering in JavaScript) while no long-lived credential enters a URL:
    /// the ticket names one run, expires within minutes and is consumed by
    /// the first request.
    pub async fn issue_download_ticket(&self, run_id: &str) -> Result<DownloadTicket, Error> {
        let run = self.run_by_id(run_id).await?;
        if run.status != runs::STATUS_COMPLETED {
            return Err(Error::NotFound(
                "bundle is not a retained completed run".to_string(),
            ));
        }
        let ttl = *self
            .ticket_ttl
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut bytes = [0u8; 32];
        rand::Rng::fill_bytes(&mut rand::rng(), &mut bytes);
        let ticket = format!("fbd_{}", hex::encode(bytes));
        let now = std::time::Instant::now();

        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        tickets.retain(|_, entry| entry.expires > now);
        if tickets.len() >= MAX_DOWNLOAD_TICKETS {
            return Err(Error::Busy(
                "too many outstanding download tickets".to_string(),
            ));
        }
        tickets.insert(
            hash_token(&ticket),
            TicketEntry {
                run_id: run.id.clone(),
                expires: now + ttl,
            },
        );
        Ok(DownloadTicket {
            ticket,
            run_id: run.id,
            expires_at: Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default(),
        })
    }

    /// Consume a ticket and open its bundle. Unknown, used and expired
    /// tickets are indistinguishable (404).
    pub async fn redeem_download_ticket(&self, ticket: &str) -> Result<BundleDownload, Error> {
        let entry = self
            .tickets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&hash_token(ticket));
        match entry {
            Some(entry) if entry.expires > std::time::Instant::now() => {
                self.open_bundle(&entry.run_id).await
            }
            _ => Err(Error::NotFound("download ticket is not valid".to_string())),
        }
    }

    /// Replace the upload timeouts (tests use short ones).
    pub fn set_upload_limits(&self, limits: UploadLimits) {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner) = limits;
    }

    fn upload_limits(&self) -> UploadLimits {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Number of per-run lock entries currently allocated. Exposed so tests
    /// can prove the map does not grow with unknown or finished runs.
    #[doc(hidden)]
    pub fn run_lock_entries(&self) -> usize {
        self.run_locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// Stop background jobs and abort pending upload body reads. Safe to
    /// call more than once.
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    /// Configured storage root, when the operator enabled backups.
    pub fn backup_dir(&self) -> Option<&Path> {
        self.config.backup_dir.as_deref()
    }

    /// Start the production maintenance/health loop. Tests construct the
    /// service directly and never call this.
    ///
    /// `shutdown` is the process-wide stop signal: when it is cancelled the
    /// loop exits after the current tick and in-flight chunk body reads are
    /// aborted with 503 (see [`Self::shutdown`]).
    pub fn start_jobs(self: &Arc<Self>, shutdown: CancellationToken) {
        let backups = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tokio::select! {
                    _ = shutdown.cancelled() => {
                        backups.shutdown();
                        break;
                    }
                    _ = backups.shutdown.cancelled() => break,
                    _ = ticker.tick() => {}
                }
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
            filename: format!(
                "flatline-backup-{}.{}",
                run.id,
                if runs::summary_is_encrypted(run.source_summary.as_ref()) {
                    "age"
                } else {
                    "tar"
                }
            ),
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
        self.publish_change();
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

        self.publish_change();
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

        self.publish_change();
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

        self.publish_change();
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
                return Err(Error::ParamsConflict(
                    "clientRunId was already used with different parameters".to_string(),
                ));
            }
            return Ok(existing);
        }

        self.refuse_active_run(agent_id).await?;

        let id = uuid::Uuid::new_v4().to_string();
        insert_run(&self.pool, &id, agent_id, &validated, now).await?;
        self.publish_change();
        self.run_by_id(&id).await
    }

    /// Record the version an agent reports running and, when given, the
    /// outcome of its host's last self-update attempt. A `None` status
    /// leaves the stored one unchanged.
    pub async fn record_version(
        &self,
        agent_id: &str,
        version: &str,
        update_status: Option<&str>,
    ) -> Result<(), Error> {
        self.record_version_at(agent_id, version, update_status, Utc::now())
            .await
    }

    async fn record_version_at(
        &self,
        agent_id: &str,
        version: &str,
        update_status: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), Error> {
        runs::validate_agent_version(version)?;
        if let Some(status) = update_status {
            runs::validate_update_status(status)?;
        }
        sqlx::query(
            "UPDATE backup_agents
                SET reported_version = ?, version_reported_at = ?,
                    update_status = COALESCE(?, update_status)
              WHERE id = ?",
        )
        .bind(version)
        .bind(now.to_rfc3339_opts(SecondsFormat::Millis, true))
        .bind(update_status)
        .bind(agent_id)
        .execute(&self.pool)
        .await?;
        self.publish_change();
        Ok(())
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
        // The version is agent metadata, recorded whatever happens to the
        // run, and never part of `same_start`: a pending bundle written by
        // an older agent and retried after an update is still the same run.
        // A malformed version is dropped, never a reason to refuse a backup.
        if let Some(version) = input.agent_version.as_deref() {
            match self.record_version_at(agent_id, version, None, now).await {
                Ok(()) | Err(Error::BadRequest(_)) => {}
                Err(error) => return Err(error),
            }
        }
        let storage = self.storage()?;

        let _reservation = self.reservation.lock().await;

        if let Some(existing) = self
            .run_by_client_id(agent_id, &validated.client_run_id)
            .await?
        {
            if !same_start(&existing, &validated) {
                return Err(Error::ParamsConflict(
                    "clientRunId was already used with different parameters".to_string(),
                ));
            }
            let status = existing.status.clone();
            match status.as_str() {
                runs::STATUS_UPLOADING | runs::STATUS_FINALIZING | runs::STATUS_COMPLETED => {
                    return Ok(existing);
                }
                runs::STATUS_EXPIRED => {
                    let (agent, run) = (agent_id.to_string(), existing.id.clone());
                    run_blocking(&storage, move |storage| storage.delete_run(&agent, &run))
                        .await
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
                    let (agent, run) = (agent_id.to_string(), existing.id.clone());
                    run_blocking(&storage, move |storage| storage.prepare_run(&agent, &run))
                        .await
                        .map_err(storage_error)?;
                    self.publish_change();
                    return self.run_by_id(&existing.id).await;
                }
                _ => {
                    return Err(Error::Terminal(format!(
                        "this run is {status} and can no longer be reopened"
                    )));
                }
            }
        }

        self.refuse_active_run(agent_id).await?;

        self.reserve_capacity(&storage, validated.total_bytes)
            .await?;

        let id = uuid::Uuid::new_v4().to_string();
        insert_run(&self.pool, &id, agent_id, &validated, now).await?;
        let (agent, run) = (agent_id.to_string(), id.clone());
        if let Err(error) =
            run_blocking(&storage, move |storage| storage.prepare_run(&agent, &run)).await
        {
            let _ = sqlx::query("DELETE FROM backup_runs WHERE id = ?")
                .bind(&id)
                .execute(&self.pool)
                .await;
            return Err(storage_error(error));
        }

        self.publish_change();
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

        // Verify ownership before touching any shared limiter, so unknown
        // ids cannot occupy a slot or grow the lock map.
        let owned = self.run_for_agent(agent_id, run_id).await?;
        let limits = self.upload_limits();

        // At most four bodies are in memory at once. The slot is taken
        // before the run lock and the body is read without the run lock, so
        // a stalled sender holds only its own slot, and only until the
        // idle/total read deadline.
        let _slot = tokio::time::timeout(limits.slot_wait, self.upload_slots.acquire())
            .await
            .map_err(|_| Error::Busy("all upload slots are busy".to_string()))?
            .map_err(|_| Error::Internal("upload limiter closed".to_string()))?;
        let bytes = read_bounded(body, CHUNK_BYTES as usize, &limits, &self.shutdown).await?;
        let digest = hex::encode(Sha256::digest(&bytes));

        if digest != sha256 {
            return Err(Error::HashMismatch(
                "chunk sha256 does not match the request body".to_string(),
            ));
        }

        let _run = self.lock_run(&owned.id, limits.lock_wait).await?;
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

        if run.status == runs::STATUS_FINALIZING {
            return Err(Error::Conflict("run is finalizing".to_string()));
        }
        if run.status != runs::STATUS_UPLOADING {
            return Err(Error::Terminal(format!(
                "run is {} and does not accept chunks",
                run.status
            )));
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

        // Write and fsync off the async workers.
        let (agent, run) = (agent_id.to_string(), run_id.to_string());
        run_blocking(&storage, move |storage| {
            storage.append_chunk(&agent, &run, offset, &bytes)
        })
        .await
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
        // Ownership first: an unknown or foreign id never allocates a lock.
        let owned = self.run_for_agent(agent_id, run_id).await?;
        let _run = self
            .lock_run(&owned.id, self.upload_limits().lock_wait)
            .await?;
        let run = self.run_for_agent(agent_id, run_id).await?;

        if run.status == runs::STATUS_COMPLETED {
            return Ok(run);
        }
        if run.status != runs::STATUS_UPLOADING && run.status != runs::STATUS_FINALIZING {
            return Err(Error::Terminal(format!(
                "run is {} and cannot be completed",
                run.status
            )));
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

        // One hashing pass plus fsync/rename, on the blocking pool.
        let (agent, run, digest) = (agent_id.to_string(), run_id.to_string(), sha256.clone());
        let finalized = run_blocking(&storage, move |storage| {
            storage.finalize(&agent, &run, total as u64, &digest)
        })
        .await;
        match finalized {
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

        self.publish_change();
        self.run_by_id(run_id).await
    }

    /// Abandon this agent's own uploading run, typically one whose local
    /// bundle no longer exists (quarantined or lost). The run becomes
    /// `failed` with `upload_abandoned`, its reservation is released at once
    /// and maintenance removes its bytes. A run with a request in flight,
    /// or already finalizing, is not abandoned.
    pub async fn abandon_run(&self, agent_id: &str, run_id: &str) -> Result<RunSummary, Error> {
        let owned = self.run_for_agent(agent_id, run_id).await?;
        let _run = self.lock_run(&owned.id, Duration::ZERO).await?;
        let run = self.run_for_agent(agent_id, run_id).await?;
        match run.status.as_str() {
            runs::STATUS_UPLOADING => {}
            runs::STATUS_FAILED if run.error_code.as_deref() == Some(runs::CODE_ABANDONED) => {
                return Ok(run);
            }
            runs::STATUS_FINALIZING => {
                return Err(Error::Conflict(
                    "run is finalizing; retry completion instead".to_string(),
                ));
            }
            other => {
                return Err(Error::Terminal(format!(
                    "run is {other} and cannot be abandoned"
                )));
            }
        }
        sqlx::query(
            "UPDATE backup_runs SET status = 'failed', error_code = ?, last_activity_at = ?
              WHERE id = ? AND status = 'uploading'",
        )
        .bind(runs::CODE_ABANDONED)
        .bind(canonical(Utc::now()))
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        self.publish_change();
        self.run_by_id(run_id).await
    }

    async fn refuse_active_run(&self, agent_id: &str) -> Result<(), Error> {
        let active: Option<(String, String)> = sqlx::query_as(
            "SELECT id, client_run_id FROM backup_runs
              WHERE agent_id = ? AND status IN ('uploading', 'finalizing')
              ORDER BY created_at, id LIMIT 1",
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await?;
        match active {
            Some((run_id, client_run_id)) => Err(Error::ActiveRun {
                run_id,
                client_run_id,
            }),
            None => Ok(()),
        }
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
                    let (agent, run, committed) = (
                        row.agent_id.clone(),
                        row.id.clone(),
                        row.received_bytes as u64,
                    );
                    let truncated = run_blocking(&storage, move |storage| {
                        storage.truncate_to_committed(&agent, &run, committed)
                    })
                    .await;
                    match truncated {
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
        let (agent, run) = (row.agent_id.clone(), row.id.clone());
        // `finalize` verifies an already-published bundle once, or hashes the
        // partial once and publishes it. Both run on the blocking pool so a
        // boot with several large finalizing runs cannot starve monitoring.
        run_blocking(storage, move |storage| {
            storage.finalize(&agent, &run, total, &sha256)
        })
        .await
        .map_err(storage_error)?;

        sqlx::query(
            "UPDATE backup_runs SET status = 'completed', completed_at = ?,
                    error_code = NULL WHERE id = ?",
        )
        .bind(canonical(Utc::now()))
        .bind(&row.id)
        .execute(&self.pool)
        .await?;
        self.publish_change();
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
        if input.client_run_id.is_empty() || input.client_run_id.len() > 128 {
            return Err(Error::BadRequest(
                "clientRunId must be 1-128 characters".to_string(),
            ));
        }
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
            // Serialize with chunk appends and finalization of this run.
            let _run = self
                .lock_run(&existing.id, self.upload_limits().lock_wait)
                .await?;
            let existing = self.run_by_id(&existing.id).await?;
            match existing.status.as_str() {
                runs::STATUS_FAILED => {
                    if existing.error_code.as_deref() == Some(input.code.as_str()) {
                        return Ok(existing);
                    }
                    return Err(Error::Conflict(
                        "clientRunId was already reported with a different code".to_string(),
                    ));
                }
                // Only an upload in progress can still turn into a failure.
                // Completed, finalizing, deleting, pruned and expired runs
                // keep their state: retention and expiry bookkeeping must
                // not be rewritten by an agent report.
                runs::STATUS_UPLOADING => {}
                other => {
                    return Err(Error::Terminal(format!(
                        "a {other} run cannot be reported as failed"
                    )));
                }
            }

            sqlx::query(
                "UPDATE backup_runs SET status = 'failed', error_code = ?
                  WHERE id = ? AND status = 'uploading'",
            )
            .bind(&input.code)
            .bind(&existing.id)
            .execute(&self.pool)
            .await?;
            self.publish_change();
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

        self.publish_change();
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

    /// Tell live clients that backup data changed. A dedicated event type,
    /// not the generic `invalidate`: only views that show backups reload,
    /// and backup progress never re-snapshots the monitor roster.
    fn publish_change(&self) {
        self.events
            .publish(serde_json::json!({ "type": "backups" }));
    }

    fn invalidate_progress(&self) {
        let now = std::time::Instant::now();
        let mut last = self.progress_event.lock().unwrap();
        let due =
            last.is_none_or(|last| now.duration_since(last) >= std::time::Duration::from_secs(1));
        if due {
            *last = Some(now);
            drop(last);
            self.publish_change();
        }
    }

    /// Acquire the per-run lock within `wait`. The entry is removed from
    /// the map again once no request holds or awaits it.
    async fn lock_run(&self, run_id: &str, wait: Duration) -> Result<RunLockGuard, Error> {
        let entry = {
            let mut locks = self
                .run_locks
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            RunLockEntry {
                key: run_id.to_string(),
                map: Arc::clone(&self.run_locks),
                entry: Some(Arc::clone(
                    locks
                        .entry(run_id.to_string())
                        .or_insert_with(|| Arc::new(Mutex::new(()))),
                )),
            }
        };
        let mutex = Arc::clone(entry.entry.as_ref().expect("entry is set until drop"));
        let guard = tokio::time::timeout(wait, mutex.lock_owned())
            .await
            .map_err(|_| Error::Busy("another request is working on this run".to_string()))?;
        Ok(RunLockGuard {
            _guard: guard,
            _entry: entry,
        })
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
        self.publish_change();
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

        self.publish_change();
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
        // Latest by export time. On a tie (an upload-failure report shares
        // its bundle's export time) a completed delivery wins.
        let latest: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM backup_runs
              WHERE agent_id = ?
              ORDER BY COALESCE(export_finished_at, export_started_at, created_at) DESC,
                       status = 'completed' DESC, id DESC
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
            reported_version: row.reported_version,
            version_reported_at: row.version_reported_at,
            update_status: row.update_status,
        })
    }
}

/// Read at most `max` bytes, giving up when the sender goes quiet for
/// `body_idle`, exceeds `body_total`, or the server shuts down.
async fn read_bounded(
    mut body: Body,
    max: usize,
    limits: &UploadLimits,
    shutdown: &CancellationToken,
) -> Result<Vec<u8>, Error> {
    let deadline = tokio::time::Instant::now() + limits.body_total;
    let mut data = Vec::new();
    loop {
        let frame = tokio::select! {
            _ = shutdown.cancelled() => {
                return Err(Error::Unavailable("server is shutting down".to_string()));
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(Error::Timeout(
                    "chunk body was not received within the read budget".to_string(),
                ));
            }
            next = tokio::time::timeout(limits.body_idle, body.frame()) => match next {
                Err(_) => {
                    return Err(Error::Timeout("chunk body stalled".to_string()));
                }
                Ok(None) => break,
                Ok(Some(frame)) => frame,
            },
        };
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
