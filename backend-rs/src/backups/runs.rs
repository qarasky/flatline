//! Run metadata, validation and the shared summary shape.
//!
//! The summary JSON is a contract with the Go uploader and the dashboard:
//! camelCase names, RFC3339 UTC times, integer bytes, null for absent values.
//! Validation happens before any storage is touched so a malformed start can
//! never reserve capacity or create a row.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Error;

/// Maximum accepted encrypted bundle size: 8 GiB.
pub const MAX_BUNDLE_BYTES: i64 = 8 * 1024 * 1024 * 1024;

/// Fixed pilot overdue threshold: 36 hours since registration or the latest
/// completed export. `intervalSeconds` is metadata and never changes this.
pub const OVERDUE_MS: i64 = 36 * 60 * 60 * 1000;

/// Uploads may declare times at most five minutes ahead of the server clock.
pub const FUTURE_TOLERANCE_MS: i64 = 5 * 60 * 1000;

/// Verification summaries are operator text, bounded to keep rows small.
pub const MAX_VERIFICATION_SUMMARY: usize = 2 * 1024;

pub const STATUS_UPLOADING: &str = "uploading";
pub const STATUS_FINALIZING: &str = "finalizing";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_EXPIRED: &str = "expired";
pub const STATUS_DELETING: &str = "deleting";
pub const STATUS_PRUNED: &str = "pruned";

/// Error code of a run its agent abandoned (its local bundle is gone).
pub const CODE_ABANDONED: &str = "upload_abandoned";

/// An operator-recorded archive or restore verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub run_id: String,
    pub status: String,
    pub checked_at: String,
    pub summary: String,
}

/// The run shape shared with the Go agent and the dashboard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub agent_id: String,
    pub client_run_id: String,
    pub status: String,
    pub export_started_at: String,
    pub export_finished_at: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub total_bytes: Option<i64>,
    pub received_bytes: i64,
    pub sha256: Option<String>,
    pub source_summary: Option<Value>,
    pub error_code: Option<String>,
    pub archive_verification: Option<Verification>,
    pub restore_verification: Option<Verification>,
}

/// A run start request. Fields are optional so the same type can describe a
/// failure report; `validate_start` requires the upload fields.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRun {
    pub client_run_id: String,
    pub export_started_at: String,
    pub export_finished_at: Option<String>,
    pub total_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub source_summary: Option<Value>,
}

/// Fully validated values, in canonical storage form.
#[derive(Debug, Clone)]
pub struct ValidatedStart {
    pub client_run_id: String,
    pub export_started_at: String,
    pub export_finished_at: String,
    pub total_bytes: i64,
    pub sha256: String,
    pub source_summary: Option<String>,
}

/// Parse either our RFC3339 timestamps or the legacy SQLite format.
pub fn parse_time(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
        .or_else(|| crate::metrics::metric_time(value))
}

fn canonical_time(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn validate_time(value: &str, label: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, Error> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| Error::BadRequest(format!("{label} must be an RFC3339 timestamp")))?
        .with_timezone(&Utc);

    if parsed.timestamp_millis() > now.timestamp_millis() + FUTURE_TOLERANCE_MS {
        return Err(Error::BadRequest(format!(
            "{label} is more than five minutes in the future"
        )));
    }
    Ok(parsed)
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validate and normalize a source summary. Only the three contracted
/// counters are stored; unknown fields are ignored rather than trusted.
fn normalize_summary(summary: Option<Value>) -> Result<Option<String>, Error> {
    let Some(value) = summary else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| Error::BadRequest("sourceSummary must be an object".to_string()))?;

    let read = |name: &str| -> Result<i64, Error> {
        match object.get(name) {
            None => Ok(0),
            Some(value) => value.as_i64().filter(|count| *count >= 0).ok_or_else(|| {
                Error::BadRequest(format!(
                    "sourceSummary.{name} must be a non-negative integer"
                ))
            }),
        }
    };

    let normalized = json!({
        "databaseCount": read("databaseCount")?,
        "objectCount": read("objectCount")?,
        "sourceBytes": read("sourceBytes")?,
    });
    Ok(Some(normalized.to_string()))
}

impl StartRun {
    /// Validate upload-start metadata. Missing upload fields are rejected.
    pub fn validate(&self, now: DateTime<Utc>) -> Result<ValidatedStart, Error> {
        if self.client_run_id.is_empty() || self.client_run_id.len() > 128 {
            return Err(Error::BadRequest(
                "clientRunId must be 1-128 characters".to_string(),
            ));
        }

        let started = validate_time(&self.export_started_at, "exportStartedAt", now)?;
        let finished_raw = self
            .export_finished_at
            .as_deref()
            .ok_or_else(|| Error::BadRequest("exportFinishedAt is required".to_string()))?;
        let finished = validate_time(finished_raw, "exportFinishedAt", now)?;
        if finished < started {
            return Err(Error::BadRequest(
                "exportFinishedAt must not precede exportStartedAt".to_string(),
            ));
        }

        let total_bytes = self
            .total_bytes
            .ok_or_else(|| Error::BadRequest("totalBytes is required".to_string()))?;
        if total_bytes <= 0 || total_bytes > MAX_BUNDLE_BYTES {
            return Err(Error::BadRequest(format!(
                "totalBytes must be between 1 and {MAX_BUNDLE_BYTES}"
            )));
        }

        let sha256 = self
            .sha256
            .as_deref()
            .ok_or_else(|| Error::BadRequest("sha256 is required".to_string()))?;
        if !valid_sha256(sha256) {
            return Err(Error::BadRequest(
                "sha256 must be 64 lowercase hexadecimal characters".to_string(),
            ));
        }

        Ok(ValidatedStart {
            client_run_id: self.client_run_id.clone(),
            export_started_at: canonical_time(started),
            export_finished_at: canonical_time(finished),
            total_bytes,
            sha256: sha256.to_string(),
            source_summary: normalize_summary(self.source_summary.clone())?,
        })
    }
}

/// Safe failure codes reported by the Go agent. Raw stderr or messages never
/// enter this channel; an unknown code is a 400.
pub const FAILURE_CODES: &[&str] = &[
    "export_failed",
    "postgres_dump_failed",
    "postgres_query_failed",
    "s3_export_failed",
    "s3_read_failed",
    "spool_limit",
    "archive_failed",
    "encrypt_failed",
    "upload_failed",
    "auth_failed",
    "config_invalid",
    "source_changed",
    "unknown",
];

pub fn valid_failure_code(code: &str) -> bool {
    FAILURE_CODES.contains(&code)
}

/// Derived agent health. The spec's single enum, in precedence order:
/// disabled, fresh failure, healthy, overdue, pending.
pub fn health_for(
    enabled: bool,
    created_at: &str,
    latest: Option<&RunSummary>,
    last_completed: Option<&RunSummary>,
    now_ms: i64,
) -> &'static str {
    if !enabled {
        return "disabled";
    }

    let within_window =
        |stamp: Option<i64>| stamp.is_some_and(|stamp| now_ms - stamp <= OVERDUE_MS);

    if let Some(run) = latest
        && run.status == STATUS_FAILED
        && within_window(parse_time(
            run.export_finished_at.as_deref().unwrap_or(&run.created_at),
        ))
    {
        return "failed";
    }

    if let Some(run) = last_completed
        && within_window(parse_time(
            run.export_finished_at.as_deref().unwrap_or(&run.created_at),
        ))
    {
        return "healthy";
    }

    let reference = last_completed
        .and_then(|run| parse_time(run.export_finished_at.as_deref().unwrap_or(&run.created_at)))
        .or_else(|| parse_time(created_at));

    if reference.is_some_and(|stamp| now_ms - stamp >= OVERDUE_MS) {
        "overdue"
    } else {
        "pending"
    }
}

/// Parse a stored verification JSON column.
pub fn parse_verification(value: Option<&str>) -> Option<Verification> {
    value.and_then(|raw| serde_json::from_str(raw).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-20T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn start() -> StartRun {
        StartRun {
            client_run_id: "run-1".to_string(),
            export_started_at: "2026-10-19T23:00:00Z".to_string(),
            export_finished_at: Some("2026-10-19T23:30:00Z".to_string()),
            total_bytes: Some(1024),
            sha256: Some("a".repeat(64)),
            source_summary: Some(json!({"databaseCount": 1})),
        }
    }

    #[test]
    fn valid_start_is_canonicalized() {
        let validated = start().validate(now()).unwrap();
        assert_eq!(validated.export_finished_at, "2026-10-19T23:30:00.000Z");
        assert_eq!(
            validated.source_summary.as_deref(),
            Some(r#"{"databaseCount":1,"objectCount":0,"sourceBytes":0}"#)
        );
    }

    #[test]
    fn rejects_reversed_future_and_oversized_metadata() {
        let mut reversed = start();
        reversed.export_finished_at = Some("2026-10-19T22:00:00Z".to_string());
        assert!(matches!(
            reversed.validate(now()),
            Err(Error::BadRequest(_))
        ));

        let mut future = start();
        future.export_finished_at = Some("2026-10-20T00:10:00Z".to_string());
        assert!(matches!(future.validate(now()), Err(Error::BadRequest(_))));

        let mut oversized = start();
        oversized.total_bytes = Some(MAX_BUNDLE_BYTES + 1);
        assert!(matches!(
            oversized.validate(now()),
            Err(Error::BadRequest(_))
        ));

        let mut digest = start();
        digest.sha256 = Some("A".repeat(64));
        assert!(matches!(digest.validate(now()), Err(Error::BadRequest(_))));
    }

    #[test]
    fn health_uses_export_time_not_receipt_time() {
        let old = RunSummary {
            id: "r".into(),
            agent_id: "a".into(),
            client_run_id: "c".into(),
            status: STATUS_COMPLETED.into(),
            export_started_at: "2026-10-17T00:00:00Z".into(),
            export_finished_at: Some("2026-10-17T01:00:00Z".into()),
            created_at: "2026-10-20T00:00:00Z".into(),
            completed_at: Some("2026-10-20T00:00:00Z".into()),
            total_bytes: Some(10),
            received_bytes: 10,
            sha256: None,
            source_summary: None,
            error_code: None,
            archive_verification: None,
            restore_verification: None,
        };
        assert_eq!(
            health_for(
                true,
                "2026-10-01T00:00:00Z",
                Some(&old),
                Some(&old),
                parse_time("2026-10-20T00:00:00Z").unwrap()
            ),
            "overdue",
            "a backup exported two days ago is overdue even if uploaded today"
        );
    }
}
