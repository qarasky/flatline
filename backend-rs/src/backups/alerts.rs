//! Backup health transitions and alert dispatch.
//!
//! Health is derived from run metadata, never from a second agent report.
//! The transition is persisted before dispatch: a restart after a successful
//! send does not repeat it, and a failed send does not retry forever. Alerts
//! reuse the existing notification rows, so no new channel or credential
//! exists. Every backup alert leaves through [`Backups::deliver_alert`].

use chrono::{DateTime, SecondsFormat, Utc};

use super::{AGENT_COLUMNS, AgentRow, Backups, Error, runs};
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
            self.publish_change();

            let message = match current.as_str() {
                "failed" => {
                    let code = summary.last_error_code.as_deref().unwrap_or("unknown");
                    Some(if runs::is_delivery_code(code) {
                        format!(
                            "[backup] {}: latest backup was not delivered ({code})",
                            summary.name
                        )
                    } else {
                        format!("[backup] {}: last export failed ({code})", summary.name)
                    })
                }
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
                self.deliver_alert(row.monitor_id, message).await;
            }
        }

        Ok(())
    }

    /// The single exit for backup alerts (reroute here for a delivery
    /// queue). Recipients are the active Telegram notifications linked to
    /// the agent's monitor. An agent with no monitor (never linked, or its
    /// monitor was deleted: `ON DELETE SET NULL`) or whose monitor has no
    /// notifications falls back to the default notifications, so a backup
    /// failure is never silently dropped.
    pub(crate) async fn deliver_alert(&self, monitor_id: Option<i64>, message: String) {
        let mut recipients = match monitor_id {
            Some(monitor_id) => match notify::linked(&self.pool, monitor_id).await {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::error!("backup alert: load links for monitor {monitor_id}: {error}");
                    Vec::new()
                }
            },
            None => Vec::new(),
        };
        recipients.retain(|(_, kind, _)| kind == "telegram");
        if recipients.is_empty() {
            recipients = match sqlx::query_as::<_, (String, String, String)>(
                "SELECT name, type, config FROM notifications
                  WHERE active = 1 AND is_default = 1 AND type = 'telegram'
                  ORDER BY id",
            )
            .fetch_all(&self.pool)
            .await
            {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::error!("backup alert: load default notifications: {error}");
                    Vec::new()
                }
            };
        }
        if recipients.is_empty() {
            tracing::error!(
                "backup alert has no recipient (link a monitor or mark a default notification): {message}"
            );
            return;
        }
        for (name, _, config) in recipients {
            let Some(telegram) = notify::parse_telegram(&config) else {
                tracing::warn!("backup alert: {name} has no usable telegram config");
                continue;
            };
            notify::deliver_telegram(&self.client, &name, &telegram, &message).await;
        }
    }
}

fn timestamp(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
