//! Named backup agents, their dedicated credentials and durable run history.
//!
//! Storage of bundle bytes lives in `storage` (receiver task); this module
//! owns identity, metadata and the state transitions that do not touch the
//! filesystem. Agent tokens are hashed with the same SHA-256 scheme as
//! operator tokens but live in their own table and authenticate only the
//! `/api/backup/v1` routes.

pub mod agents;
pub mod runs;

use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::auth::hash_token;
use crate::config::Config;
use crate::events::Events;
use runs::{ValidatedStart, Verification};

pub use runs::{RunSummary, StartRun};

/// Service error mapped to the HTTP contract by `api::backups`.
#[derive(Debug)]
pub enum Error {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    Unauthorized,
    Unavailable(String),
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
}

const AGENT_COLUMNS: &str = "id, name, monitor_id, enabled, interval_seconds, retention_count, \
                             credential_active, created_at";

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
}

impl Backups {
    pub fn new(pool: SqlitePool, config: Arc<Config>, events: Arc<Events>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            config,
            events,
        })
    }

    /// Configured storage root, when the operator enabled backups.
    pub fn backup_dir(&self) -> Option<&Path> {
        self.config.backup_dir.as_deref()
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

    /// Create or replay the metadata row for an upload. Byte delivery is
    /// handled by the receiver task; this method never touches storage.
    pub async fn start_run_at(
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
              WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
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
             created_at, total_bytes, received_bytes, sha256, source_summary)
         VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, 0, ?, ?)",
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
