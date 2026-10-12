//! Notification dispatch. Telegram is the only provider in v1 (locked
//! scope) and the one the office instance actually uses.
//!
//! Message shape matches the Node provider with templates off (the office
//! config has `telegramUseTemplate: false`): `[name] [🔴 Down] message`.
//! Sends are spawned by the engine so a slow bot API can never delay a
//! heartbeat or a check.

use serde_json::Value;
use sqlx::SqlitePool;

use crate::heartbeats::UP;

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

/// The plain-text alert, matching the Node provider's default message.
pub fn heartbeat_message(monitor_name: &str, status: i64, msg: &str) -> String {
    let tag = if status == UP { "✅ Up" } else { "🔴 Down" };
    format!("[{monitor_name}] [{tag}] {msg}")
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
    fn message_shape_matches_node() {
        assert_eq!(
            heartbeat_message("cmn", 0, "No heartbeat in the time window"),
            "[cmn] [🔴 Down] No heartbeat in the time window"
        );
        assert_eq!(
            heartbeat_message("cmn", 1, "200 - OK"),
            "[cmn] [✅ Up] 200 - OK"
        );
    }
}
