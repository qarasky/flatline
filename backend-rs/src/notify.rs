//! Notification dispatch. Telegram is the only provider in v1 (locked
//! scope) and the one the office instance actually uses.
//!
//! Message shape matches the Node provider with templates off (the office
//! config has `telegramUseTemplate: false`): `[name] [🔴 Down] message`.
//! Sends are spawned by the engine so a slow bot API can never delay a
//! heartbeat or a check.

use serde_json::Value;
use sqlx::SqlitePool;

use crate::heartbeats::{PENDING, UP};
use crate::monitors::Monitor;

/// A Telegram config parsed from a notification row.
#[derive(Debug, Clone)]
pub struct Telegram {
    pub server_url: String,
    pub bot_token: String,
    pub chat_id: String,
    pub disable_notification: bool,
    pub protect_content: bool,
    pub message_thread_id: Option<Value>,
}

/// Parse the `config` JSON of a notification row. A missing token or chat
/// id means the row cannot send; the caller skips it.
pub fn parse_telegram(config: &str) -> Option<Telegram> {
    let value: Value = serde_json::from_str(config).ok()?;

    let bot_token = value.get("telegramBotToken")?.as_str()?.to_string();
    let chat_id = value.get("telegramChatID")?.as_str()?.to_string();
    if bot_token.is_empty() || chat_id.is_empty() {
        return None;
    }

    Some(Telegram {
        server_url: value
            .get("telegramServerUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .unwrap_or("https://api.telegram.org")
            .trim_end_matches('/')
            .to_string(),
        bot_token,
        chat_id,
        disable_notification: value
            .get("telegramSendSilently")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        protect_content: value
            .get("telegramProtectContent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message_thread_id: value
            .get("telegramMessageThreadID")
            .filter(|thread| !thread.is_null())
            .cloned(),
    })
}

/// The operator-requested alert shape: one bracketed field per line.
///
/// ```text
/// [🔴 DOWN] [work / MEKS] [modernization-meks]
/// [push] [modernization-meks]
/// [No heartbeat in the time window]
/// [CPU 12% · RAM 43% · Disk / 71% · Load 0.42]
/// ```
///
/// Line 4 exists for push monitors only (their last telemetry); everything
/// else is three lines.
pub struct AlertParts {
    pub name: String,
    pub kind: String,
    /// Ancestor group names, outermost first ("work / MEKS"), None at root.
    pub group: Option<String>,
    /// Check target: URL, IP/hostname, agent hostname or child count.
    pub target: Option<String>,
    pub status: i64,
    pub message: String,
    /// One-line metrics summary for push monitors.
    pub metrics: Option<String>,
}

/// Render the parts into the plain-text alert.
pub fn format_alert(parts: &AlertParts) -> String {
    let tag = match parts.status {
        UP => "✅ UP",
        PENDING => "⏳ PENDING",
        _ => "🔴 DOWN",
    };
    let group = parts.group.as_deref().unwrap_or("Ungrouped");

    let mut lines = vec![format!("[{tag}] [{group}] [{}]", parts.name)];

    let target = parts.target.as_deref().filter(|target| !target.is_empty());
    lines.push(match target {
        Some(target) => format!("[{}] [{target}]", parts.kind),
        None => format!("[{}]", parts.kind),
    });

    // Messages are single-line by contract; collapse any stray whitespace
    // so one field can never look like two.
    lines.push(format!("[{}]", single_line(&parts.message)));
    if let Some(metrics) = &parts.metrics {
        lines.push(format!("[{metrics}]"));
    }

    lines.join("\n")
}

fn single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Ancestor group names of a monitor, outermost first ("work / MEKS").
/// `None` for a root-level monitor; broken links stop the walk.
pub async fn group_path(pool: &SqlitePool, parent: Option<i64>) -> Option<String> {
    let mut names: Vec<String> = Vec::new();
    let mut cursor = parent;
    for _ in 0..64 {
        let Some(id) = cursor else { break };
        let row: Option<(String, Option<i64>)> =
            sqlx::query_as("SELECT name, parent FROM monitors WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
        let Some((name, next)) = row else { break };
        names.push(name);
        cursor = next;
    }
    if names.is_empty() {
        return None;
    }
    names.reverse();
    Some(names.join(" / "))
}

/// Build the alert for one heartbeat: group path, check target and — for
/// push monitors — a line of the last telemetry the agent sent.
pub async fn build_heartbeat_message(
    pool: &SqlitePool,
    monitor: &Monitor,
    status: i64,
    message: &str,
) -> String {
    let group = group_path(pool, monitor.parent).await;
    let mut target = match monitor.kind.as_str() {
        "http" | "https" | "keyword" => monitor.url.clone(),
        "ping" => monitor.hostname.clone(),
        _ => monitor.url.clone().or_else(|| monitor.hostname.clone()),
    };
    let mut metrics = None;

    match monitor.kind.as_str() {
        "group" => {
            let children: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM monitors WHERE parent = ?")
                    .bind(monitor.id)
                    .fetch_one(pool)
                    .await
                    .unwrap_or(0);
            target = Some(format!("{children} children"));
        }
        "push" => {
            if let Some(sample) = latest_sample(pool, monitor.id).await {
                let hostname = sample
                    .pointer("/host/hostname")
                    .and_then(Value::as_str)
                    .filter(|hostname| !hostname.is_empty());
                if let Some(hostname) = hostname {
                    target = Some(hostname.to_string());
                }
                metrics = metrics_line(&sample);
            }
            if target.as_deref().is_none_or(str::is_empty) {
                target = Some(monitor.name.clone());
            }
        }
        _ => {}
    }

    format_alert(&AlertParts {
        name: monitor.name.clone(),
        kind: monitor.kind.clone(),
        group,
        target,
        status,
        message: message.to_string(),
        metrics,
    })
}

/// Newest archived telemetry sample for a monitor, if any.
async fn latest_sample(pool: &SqlitePool, monitor_id: i64) -> Option<Value> {
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM metrics_raw WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1",
    )
    .bind(monitor_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    serde_json::from_str(payload.as_deref()?).ok()
}

/// One-line usage summary from a telemetry sample: CPU, RAM, the fullest
/// disk and the 1-minute load. `None` when the sample carries none of them.
pub fn metrics_line(sample: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if let Some(cpu) = sample.pointer("/cpu/percent").and_then(Value::as_f64) {
        parts.push(format!("CPU {}", percent(cpu)));
    }
    if let Some(mem) = sample.pointer("/mem/percent").and_then(Value::as_f64) {
        parts.push(format!("RAM {}", percent(mem)));
    }
    if let Some(disks) = sample.get("disk").and_then(Value::as_array) {
        let fullest = disks
            .iter()
            .filter_map(|disk| {
                let percent = disk.get("percent").and_then(Value::as_f64)?;
                let mount = disk.get("mount").and_then(Value::as_str).unwrap_or("");
                Some((mount, percent))
            })
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((mount, used)) = fullest {
            let mount = if mount.is_empty() {
                String::new()
            } else {
                format!(" {mount}")
            };
            parts.push(format!("Disk{mount} {}", percent(used)));
        }
    }
    if let Some(load) = sample.pointer("/load/avg1").and_then(Value::as_f64) {
        parts.push(format!("Load {load:.2}"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

/// 7.5% and 75%: one decimal below ten, whole numbers above.
fn percent(value: f64) -> String {
    if value < 10.0 {
        format!("{value:.1}%")
    } else {
        format!("{value:.0}%")
    }
}

/// Send one Telegram message. Errors are returned for the caller to log; a
/// failed notification must never fail a heartbeat.
pub async fn send_telegram(
    client: &reqwest::Client,
    config: &Telegram,
    text: &str,
) -> anyhow::Result<()> {
    let mut body = serde_json::json!({
        "chat_id": config.chat_id,
        "text": text,
        "disable_notification": config.disable_notification,
        "protect_content": config.protect_content,
        "link_preview_options": { "is_disabled": true },
    });
    if let Some(thread) = &config.message_thread_id {
        body["message_thread_id"] = thread.clone();
    }

    let url = format!("{}/bot{}/sendMessage", config.server_url, config.bot_token);
    let response = client.post(url).json(&body).send().await?;
    if !response.status().is_success() {
        anyhow::bail!("telegram answered {}", response.status());
    }
    Ok(())
}

/// Active notification rows linked to a monitor: `(name, type, config)`.
pub async fn linked(
    pool: &SqlitePool,
    monitor_id: i64,
) -> sqlx::Result<Vec<(String, String, String)>> {
    sqlx::query_as(
        "SELECT n.name, n.type, n.config
         FROM notifications n
         JOIN monitor_notifications mn ON mn.notification_id = n.id
         WHERE mn.monitor_id = ? AND n.active = 1",
    )
    .bind(monitor_id)
    .fetch_all(pool)
    .await
}

/// Deliver one message to every active notification linked to a monitor.
/// Failures are logged per provider, never thrown: a broken notification
/// must never fail a heartbeat or an ingest.
pub async fn dispatch_message(
    pool: &SqlitePool,
    client: &reqwest::Client,
    monitor_id: i64,
    message: String,
) {
    let rows = match linked(pool, monitor_id).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!("notify: load links for monitor {monitor_id}: {error}");
            return;
        }
    };

    for (name, kind, config) in rows {
        if kind != "telegram" {
            continue;
        }
        let Some(telegram) = parse_telegram(&config) else {
            tracing::warn!("notify: {name} has no usable telegram config");
            continue;
        };
        if let Err(error) = send_telegram(client, &telegram, &message).await {
            tracing::error!("notify: telegram send for {name} failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_office_config_shape() {
        let config = r#"{
            "name": "MBG Alerts",
            "type": "telegram",
            "telegramServerUrl": "https://api.telegram.org",
            "telegramChatID": "-1003740273903",
            "telegramBotToken": "123:abc",
            "telegramUseTemplate": false
        }"#;

        let parsed = parse_telegram(config).expect("config must parse");
        assert_eq!(parsed.chat_id, "-1003740273903");
        assert_eq!(parsed.bot_token, "123:abc");
        assert!(!parsed.disable_notification);
        assert!(!parsed.protect_content);
        assert!(parsed.message_thread_id.is_none());
    }

    #[test]
    fn refuses_configs_without_credentials() {
        assert!(parse_telegram("{}").is_none());
        assert!(parse_telegram(r#"{"telegramBotToken": ""}"#).is_none());
        assert!(parse_telegram("not json").is_none());
    }

    #[test]
    fn alert_shape_is_one_bracketed_field_per_line() {
        let http = format_alert(&AlertParts {
            name: "national-business".into(),
            kind: "http".into(),
            group: Some("work / nationalbusiness.kz".into()),
            target: Some("https://nationalbusiness.kz".into()),
            status: 0,
            message: "500 - Internal Server Error".into(),
            metrics: None,
        });
        assert_eq!(
            http,
            "[🔴 DOWN] [work / nationalbusiness.kz] [national-business]\n\
             [http] [https://nationalbusiness.kz]\n\
             [500 - Internal Server Error]"
        );

        let up = format_alert(&AlertParts {
            name: "cmn".into(),
            kind: "push".into(),
            group: None,
            target: Some("cmn".into()),
            status: 1,
            message: "OK".into(),
            metrics: None,
        });
        assert_eq!(up, "[✅ UP] [Ungrouped] [cmn]\n[push] [cmn]\n[OK]");
    }

    #[test]
    fn push_alerts_carry_the_last_metrics_line() {
        let message = format_alert(&AlertParts {
            name: "modernization-meks".into(),
            kind: "push".into(),
            group: Some("work / MEKS".into()),
            target: Some("modernization-meks".into()),
            status: 0,
            message: "No heartbeat in the time window".into(),
            metrics: Some("CPU 12% · RAM 43% · Disk / 71% · Load 0.42".into()),
        });
        assert_eq!(
            message,
            "[🔴 DOWN] [work / MEKS] [modernization-meks]\n\
             [push] [modernization-meks]\n\
             [No heartbeat in the time window]\n\
             [CPU 12% · RAM 43% · Disk / 71% · Load 0.42]"
        );
    }

    #[test]
    fn metrics_line_uses_the_fullest_disk_and_hides_missing_parts() {
        let sample = serde_json::json!({
            "cpu": { "percent": 7.56 },
            "mem": { "percent": 43.2 },
            "disk": [
                { "mount": "/", "percent": 71.4 },
                { "mount": "/data", "percent": 12.0 },
            ],
            "load": { "avg1": 0.421 },
        });
        assert_eq!(
            metrics_line(&sample).unwrap(),
            "CPU 7.6% · RAM 43% · Disk / 71% · Load 0.42"
        );

        assert!(metrics_line(&serde_json::json!({})).is_none());
    }

    #[test]
    fn messages_stay_single_line() {
        let message = format_alert(&AlertParts {
            name: "cmn".into(),
            kind: "push".into(),
            group: None,
            target: None,
            status: 2,
            message: "first\nsecond".into(),
            metrics: None,
        });
        assert_eq!(
            message,
            "[⏳ PENDING] [Ungrouped] [cmn]\n[push]\n[first second]"
        );
    }
}
