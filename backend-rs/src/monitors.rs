//! Monitor model, payload validation and the JSON shape the SPA consumes.
//!
//! Only the types the operator uses exist here: `push`, `http`, `https` and
//! `group`. Fields outside [`WRITABLE_FIELDS`] are ignored and reported back
//! in `ignoredFields`, exactly like the Node backend, so the reused SPA can
//! keep sending its whole form.

use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

use crate::api::ApiError;
use crate::auth::mint_token;

/// Monitor types this backend understands.
pub const TYPES: &[&str] = &["http", "https", "push", "group"];

/// Fields a create/patch payload may set. Anything else is ignored.
pub const WRITABLE_FIELDS: &[&str] = &[
    "active",
    "description",
    "interval",
    "retryInterval",
    "maxretries",
    "resendInterval",
    "timeout",
    "upsideDown",
    "parent",
    "weight",
    "url",
    "method",
    "accepted_statuscodes",
    "ignoreTls",
    "maxredirects",
    "pushToken",
    "metricCpuThreshold",
    "metricRamThreshold",
    "metricDiskThreshold",
];

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Monitor {
    pub id: i64,
    pub name: String,
    #[sqlx(rename = "type")]
    pub kind: String,
    pub active: i64,
    pub description: Option<String>,
    pub interval: i64,
    pub retry_interval: i64,
    pub maxretries: i64,
    pub timeout: i64,
    pub resend_interval: i64,
    pub upside_down: i64,
    pub parent: Option<i64>,
    pub weight: i64,
    pub url: Option<String>,
    pub method: Option<String>,
    pub accepted_statuscodes: String,
    pub ignore_tls: i64,
    pub maxredirects: i64,
    pub push_token: Option<String>,
    pub metric_cpu_threshold: Option<i64>,
    pub metric_ram_threshold: Option<i64>,
    pub metric_disk_threshold: Option<i64>,
    pub created_at: String,
}

impl Monitor {
    /// A new monitor with Node-compatible defaults.
    pub fn new(name: String, kind: String) -> Self {
        Self {
            id: 0,
            name,
            kind,
            active: 1,
            description: None,
            interval: 20,
            retry_interval: 20,
            maxretries: 0,
            timeout: 16,
            resend_interval: 0,
            upside_down: 0,
            parent: None,
            weight: 0,
            url: None,
            method: None,
            accepted_statuscodes: "[\"200-299\"]".to_string(),
            ignore_tls: 0,
            maxredirects: 10,
            push_token: None,
            metric_cpu_threshold: None,
            metric_ram_threshold: None,
            metric_disk_threshold: None,
            created_at: String::new(),
        }
    }
}

/// The latest heartbeat of a monitor, for status resolution.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Beat {
    pub status: i64,
    pub ping: Option<f64>,
    pub msg: Option<String>,
    pub time: String,
}

/// Serialise a monitor the way the SPA expects.
///
/// Beyond the Node shape this includes the editable fields (method,
/// retries, thresholds, …), which fixes the edit form's prefill wart: the
/// SPA tolerates extra keys, and the form can now show what a monitor
/// actually uses.
pub fn monitor_json(m: &Monitor, beat: Option<&Beat>) -> Value {
    let (status, ping, last_check, last_message) = match beat {
        Some(b) => (json!(b.status), json!(b.ping), json!(b.time), json!(b.msg)),
        // No heartbeat yet: Node reports PENDING.
        None => (json!(2), Value::Null, Value::Null, Value::Null),
    };

    let status_codes: Value =
        serde_json::from_str(&m.accepted_statuscodes).unwrap_or_else(|_| json!(["200-299"]));

    json!({
        "id": m.id,
        "name": m.name,
        "type": m.kind,
        "url": m.url,
        "status": status,
        "ping": ping,
        "lastCheck": last_check,
        "lastMessage": last_message,
        "active": m.active != 0,
        "interval": m.interval,
        "weight": m.weight,
        "parent": m.parent,
        "uptime24h": Value::Null,
        "uptime7d": Value::Null,
        "uptime30d": Value::Null,
        "metricCpuThreshold": m.metric_cpu_threshold,
        "metricRamThreshold": m.metric_ram_threshold,
        "metricDiskThreshold": m.metric_disk_threshold,
        "description": m.description,
        "method": m.method,
        "accepted_statuscodes": status_codes,
        "maxretries": m.maxretries,
        "retryInterval": m.retry_interval,
        "resendInterval": m.resend_interval,
        "timeout": m.timeout,
        "upsideDown": m.upside_down != 0,
        "ignoreTls": m.ignore_tls != 0,
        "maxredirects": m.maxredirects,
        "pushToken": m.push_token,
        "createdDate": m.created_at,
    })
}

/// Apply a create/patch payload onto a monitor. Returns the ignored keys.
///
/// Values are validated, never coerced silently: a bad interval is a 400,
/// not a clamp the operator never sees.
pub fn apply_payload(
    monitor: &mut Monitor,
    payload: &Map<String, Value>,
    creating: bool,
) -> Result<Vec<String>, ApiError> {
    let mut ignored = Vec::new();

    for (key, value) in payload {
        match key.as_str() {
            "name" => monitor.name = nonempty_string(value, "name")?,
            // Type is handled by the callers (create requires it, patch
            // rejects changes) so it never reaches this match as an update.
            "type" if creating => {}
            "active" => monitor.active = bool_int(value, "active")?,
            "description" => monitor.description = optional_string(value),
            "interval" => monitor.interval = bounded_int(value, "interval", 20, 86_400)?,
            "retryInterval" => {
                monitor.retry_interval = bounded_int(value, "retryInterval", 1, 86_400)?
            }
            "maxretries" => monitor.maxretries = bounded_int(value, "maxretries", 0, 1_000)?,
            "resendInterval" => {
                monitor.resend_interval = bounded_int(value, "resendInterval", 0, 100_000)?
            }
            "timeout" => monitor.timeout = bounded_int(value, "timeout", 1, 86_400)?,
            "upsideDown" => monitor.upside_down = bool_int(value, "upsideDown")?,
            "parent" => {
                monitor.parent =
                    match value {
                        Value::Null => None,
                        Value::Number(n) => Some(n.as_i64().ok_or_else(|| {
                            ApiError::bad("`parent` must be a monitor id or null.")
                        })?),
                        _ => return Err(ApiError::bad("`parent` must be a monitor id or null.")),
                    }
            }
            "weight" => monitor.weight = bounded_int(value, "weight", -100_000, 100_000)?,
            "url" => monitor.url = optional_string(value),
            "method" => monitor.method = optional_string(value),
            "accepted_statuscodes" => {
                monitor.accepted_statuscodes = status_codes(value)?;
            }
            "ignoreTls" => monitor.ignore_tls = bool_int(value, "ignoreTls")?,
            "maxredirects" => monitor.maxredirects = bounded_int(value, "maxredirects", 0, 100)?,
            "pushToken" => monitor.push_token = optional_string(value),
            "metricCpuThreshold" => monitor.metric_cpu_threshold = threshold(value),
            "metricRamThreshold" => monitor.metric_ram_threshold = threshold(value),
            "metricDiskThreshold" => monitor.metric_disk_threshold = threshold(value),
            // Accepted and silently ignored, exactly like the Node backend.
            "notificationIDList" => {}
            _ => ignored.push(key.clone()),
        }
    }

    Ok(ignored)
}

/// Create defaults that depend on the interval, mirroring the Node form's
/// repair: timeout is 80% of the interval and retries use the interval.
pub fn apply_interval_defaults(monitor: &mut Monitor, payload: &Map<String, Value>) {
    if !payload.contains_key("timeout") {
        monitor.timeout = ((monitor.interval as f64) * 0.8).floor() as i64;
    }
    if !payload.contains_key("retryInterval") {
        monitor.retry_interval = monitor.interval;
    }
}

/// Validate the parent link: it must exist, be a group, and not create a
/// cycle. `self_id` is None on create.
pub async fn validate_parent(
    pool: &SqlitePool,
    self_id: Option<i64>,
    parent: Option<i64>,
) -> Result<(), ApiError> {
    let Some(parent_id) = parent else {
        return Ok(());
    };

    if Some(parent_id) == self_id {
        return Err(ApiError::bad("Invalid Monitor Group"));
    }

    let kind: Option<String> = sqlx::query_scalar("SELECT type FROM monitors WHERE id = ?")
        .bind(parent_id)
        .fetch_optional(pool)
        .await
        .map_err(internal)?;

    match kind.as_deref() {
        Some("group") => {}
        _ => return Err(ApiError::bad("Invalid Monitor Group")),
    }

    // Walk up from the parent; reaching ourselves means a cycle.
    let mut cursor = Some(parent_id);
    for _ in 0..64 {
        let Some(current) = cursor else {
            return Ok(());
        };
        if Some(current) == self_id {
            return Err(ApiError::bad("Invalid Monitor Group"));
        }
        cursor = sqlx::query_scalar("SELECT parent FROM monitors WHERE id = ?")
            .bind(current)
            .fetch_optional(pool)
            .await
            .map_err(internal)?
            .flatten();
    }

    Err(ApiError::bad("Invalid Monitor Group"))
}

fn internal(e: sqlx::Error) -> ApiError {
    tracing::error!("monitors: {e}");
    ApiError::server()
}

fn nonempty_string(value: &Value, field: &str) -> Result<String, ApiError> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Ok(s.clone()),
        _ => Err(ApiError::bad(format!(
            "`{field}` must be a non-empty string."
        ))),
    }
}

fn optional_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn bool_int(value: &Value, field: &str) -> Result<i64, ApiError> {
    match value {
        Value::Bool(b) => Ok(if *b { 1 } else { 0 }),
        _ => Err(ApiError::bad(format!("`{field}` must be a boolean."))),
    }
}

fn bounded_int(value: &Value, field: &str, min: i64, max: i64) -> Result<i64, ApiError> {
    let n = value
        .as_i64()
        .ok_or_else(|| ApiError::bad(format!("`{field}` must be an integer.")))?;
    if n < min || n > max {
        return Err(ApiError::bad(format!(
            "`{field}` must be between {min} and {max}."
        )));
    }
    Ok(n)
}

/// Status codes: an array of strings, stored as JSON text.
fn status_codes(value: &Value) -> Result<String, ApiError> {
    let Some(items) = value.as_array() else {
        return Err(ApiError::bad(
            "`accepted_statuscodes` must be an array of strings.",
        ));
    };
    if !items.iter().all(Value::is_string) {
        return Err(ApiError::bad(
            "`accepted_statuscodes` must be an array of strings.",
        ));
    }
    Ok(serde_json::to_string(items).unwrap_or_else(|_| "[\"200-299\"]".to_string()))
}

/// Thresholds: 1-100, anything else means "disabled" (null), matching the
/// Node normaliser — a typo must disable an alert, never fire it wrong.
fn threshold(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| (1..=100).contains(n))
}

/// Generate the push token a push monitor reports with.
pub fn generate_push_token() -> String {
    mint_token()
}
