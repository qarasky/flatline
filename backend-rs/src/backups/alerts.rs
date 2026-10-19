//! Backup health transitions and alert dispatch.
//!
//! Health is derived from run metadata, never from a second agent report.
//! The transition is persisted before dispatch: a restart after a successful
//! send does not repeat it, and a failed send does not retry forever. Alerts
//! reuse the monitor's existing notification links (`notify::dispatch_message`),
//! so no new channel or credential exists.

use chrono::{DateTime, SecondsFormat, Utc};

use super::{AGENT_COLUMNS, AgentRow, Backups, Error};
use crate::notify;

impl Backups {
    /// Compare each agent's derived health with the persisted transition
    /// state and notify on failure, overdue and recovery.
    pub async fn evaluate_health(&self, now_ms: i64) -> Result<(), Error> {
        let rows: Vec<AgentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {AGENT_COLUMNS} FROM backup_agents"
        )))
        .fetch_all(&self.pool)
        .await?;

        for row in rows {
            let previous = row.alert_state.clone();
            let summary = self.agent_summary_from_row(row.clone(), now_ms).await?;
            let current = summary.health.clone();
            if current == previous {
                continue;
            }

            // Persist before dispatch: exactly one notification per
            // transition, even across a crash.
            sqlx::query(
                "UPDATE backup_agents SET alert_state = ?, alert_changed_at = ? WHERE id = ?",
            )
            .bind(&current)
            .bind(timestamp(now_ms))
            .bind(&row.id)
            .execute(&self.pool)
            .await?;
            self.events.invalidate();

            let Some(monitor_id) = row.monitor_id else {
                continue;
            };

            let message = match current.as_str() {
                "failed" => Some(format!(
                    "[backup] {}: last export failed ({})",
                    summary.name,
                    summary.last_error_code.as_deref().unwrap_or("unknown")
                )),
                "overdue" => Some(format!(
                    "[backup] {}: no completed export for over 36 hours",
                    summary.name
                )),
                // Recovery is only meaningful after a failure/overdue alert;
                // the first successful backup is not a recovery.
                "healthy" if previous == "failed" || previous == "overdue" => Some(format!(
                    "[backup] {}: recovery — latest export completed",
                    summary.name
                )),
                _ => None,
            };

            if let Some(message) = message {
                notify::dispatch_message(&self.pool, &self.client, monitor_id, message).await;
            }
        }

        Ok(())
    }
}

fn timestamp(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
