//! Retention, expiration and restart-safe deletion.
//!
//! Deletion is two-phase: mark a run `deleting` with a reason, remove its
//! bytes and chunk ledger, then mark it `pruned` (retention) or `expired`
//! (abandoned upload). A crash between the phases is finished by
//! [`Backups::reconcile`], never by leaving orphaned bytes or a stuck row.
//! Run metadata survives pruning; only the bytes disappear. Retention keeps
//! the newest `retentionCount` completed runs plus the latest restore-tested
//! and the latest archive-verified run.

use chrono::{DateTime, SecondsFormat, Utc};

use super::storage::run_blocking;
use super::{Backups, Error};

/// An upload with no accepted chunk/activity for 48 hours is abandoned.
pub const EXPIRE_AFTER_MS: i64 = 48 * 60 * 60 * 1000;

fn timestamp(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Backups {
    /// Boot reconciliation: finish interrupted finalizations/deletions before
    /// new uploads are accepted.
    pub async fn reconcile(&self, _now_ms: i64) -> Result<(), Error> {
        self.reconcile_storage().await?;
        self.resume_deletions().await
    }

    /// One maintenance tick: finish pending deletions, expire abandoned
    /// uploads and prune completed recovery points beyond the agent's
    /// retention count. Only `completed` runs count as recovery points.
    pub async fn maintain(&self, now_ms: i64) -> Result<(), Error> {
        self.resume_deletions().await?;

        let mut changed = false;
        let cutoff = timestamp(now_ms - EXPIRE_AFTER_MS);

        let stale: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM backup_runs
              WHERE status IN ('uploading', 'finalizing')
                AND COALESCE(last_activity_at, created_at) < ?",
        )
        .bind(&cutoff)
        .fetch_all(&self.pool)
        .await?;
        for (id,) in &stale {
            self.mark_deleting(id, "expired").await?;
            changed = true;
        }

        // Failed uploads may still hold partial bytes (for example a full
        // digest mismatch after every chunk arrived). Keep the run metadata,
        // drop its bytes and chunk ledger so the spool cannot leak.
        let failed: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, agent_id FROM backup_runs
              WHERE status = 'failed' AND received_bytes > 0",
        )
        .fetch_all(&self.pool)
        .await?;
        if let Some(storage) = self.storage().ok() {
            for (id, agent_id) in &failed {
                let (agent, run) = (agent_id.clone(), id.clone());
                if let Err(error) =
                    run_blocking(&storage, move |storage| storage.delete_run(&agent, &run)).await
                {
                    tracing::warn!("failed-run cleanup of {id} failed: {error}");
                    continue;
                }
                sqlx::query("DELETE FROM backup_run_chunks WHERE run_id = ?")
                    .bind(id)
                    .execute(&self.pool)
                    .await?;
                sqlx::query("UPDATE backup_runs SET received_bytes = 0 WHERE id = ?")
                    .bind(id)
                    .execute(&self.pool)
                    .await?;
                changed = true;
            }
        }

        let agents: Vec<(String, i64)> =
            sqlx::query_as("SELECT id, retention_count FROM backup_agents")
                .fetch_all(&self.pool)
                .await?;

        for (agent_id, retention) in &agents {
            let protected = self.protected_runs(agent_id).await?;
            let excess: Vec<(String,)> = sqlx::query_as(
                "SELECT id FROM backup_runs
                  WHERE agent_id = ? AND status = 'completed'
                  ORDER BY COALESCE(export_finished_at, completed_at, created_at) DESC, id DESC
                  LIMIT -1 OFFSET ?",
            )
            .bind(agent_id)
            .bind(retention)
            .fetch_all(&self.pool)
            .await?;
            for (id,) in &excess {
                if protected.contains(id) {
                    continue;
                }
                self.mark_deleting(id, "retention").await?;
                changed = true;
            }
        }

        if changed {
            self.resume_deletions().await?;
        }
        Ok(())
    }

    /// Recovery points retention never removes, on top of the newest
    /// `retentionCount`: the latest run with a passed restore test and the
    /// latest run with a passed archive verification. Count-only retention
    /// would otherwise delete the only proven-restorable bundle once enough
    /// untested backups arrive.
    async fn protected_runs(&self, agent_id: &str) -> Result<Vec<String>, Error> {
        let mut protected = Vec::new();
        for column in ["restore_verification", "archive_verification"] {
            let latest: Option<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT id FROM backup_runs
                  WHERE agent_id = ? AND status = 'completed'
                    AND json_extract({column}, '$.status') = 'passed'
                  ORDER BY COALESCE(export_finished_at, completed_at, created_at) DESC, id DESC
                  LIMIT 1"
            )))
            .bind(agent_id)
            .fetch_optional(&self.pool)
            .await?;
            protected.extend(latest.map(|(id,)| id));
        }
        Ok(protected)
    }

    /// Finish every `deleting` row. Rows whose storage is unavailable stay
    /// `deleting` and are retried on the next tick; monitoring is unaffected.
    async fn resume_deletions(&self) -> Result<(), Error> {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, agent_id, COALESCE(delete_reason, 'retention')
               FROM backup_runs WHERE status = 'deleting'",
        )
        .fetch_all(&self.pool)
        .await?;
        if rows.is_empty() {
            return Ok(());
        }

        let storage = match self.storage() {
            Ok(storage) => storage,
            Err(Error::Unavailable(message)) => {
                tracing::warn!("backup deletion deferred: {message}");
                return Ok(());
            }
            Err(error) => return Err(error),
        };

        let mut changed = false;
        for (id, agent_id, reason) in rows {
            let (agent, run) = (agent_id.clone(), id.clone());
            if let Err(error) =
                run_blocking(&storage, move |storage| storage.delete_run(&agent, &run)).await
            {
                tracing::warn!("backup deletion of run {id} failed: {error}");
                continue;
            }

            sqlx::query("DELETE FROM backup_run_chunks WHERE run_id = ?")
                .bind(&id)
                .execute(&self.pool)
                .await?;

            let terminal = if reason == "expired" {
                "expired"
            } else {
                "pruned"
            };
            sqlx::query(
                "UPDATE backup_runs
                    SET status = ?, received_bytes = 0,
                        error_code = CASE WHEN ? = 'expired'
                                          THEN COALESCE(error_code, 'upload_expired')
                                          ELSE error_code END
                  WHERE id = ?",
            )
            .bind(terminal)
            .bind(terminal)
            .bind(&id)
            .execute(&self.pool)
            .await?;
            changed = true;
        }

        if changed {
            self.events.invalidate();
        }
        Ok(())
    }

    async fn mark_deleting(&self, run_id: &str, reason: &str) -> Result<(), Error> {
        sqlx::query(
            "UPDATE backup_runs SET status = 'deleting', delete_reason = ?
              WHERE id = ? AND status IN ('completed', 'uploading', 'finalizing')",
        )
        .bind(reason)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
