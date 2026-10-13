//! One-time importer from the Node (redbean) SQLite database.
//!
//! Runs offline against a copy of the old database: the old file is opened
//! read-only, the new database is created in the Rust backend's data
//! directory. The importer never writes to the old file and refuses to run
//! against a non-empty new database unless `--force` clears it first.
//!
//! Only the locked scope is carried over: push/http/https/group monitors,
//! heartbeats, metrics (raw and hourly), notifications, API keys and the
//! status-page configuration. Anything else is reported and skipped — a
//! silent drop would be a monitoring outage nobody notices.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use sqlx::Row;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};

use crate::auth;
use crate::db;

/// Monitor types this backend understands; anything else is reported and
/// skipped (the locked scope plus ping, added after the import validation).
const SUPPORTED_TYPES: [&str; 5] = ["http", "https", "push", "ping", "group"];

#[derive(Debug, Default)]
pub struct ImportReport {
    pub monitors: usize,
    pub skipped_monitors: Vec<(String, String)>,
    pub heartbeats: usize,
    pub orphan_heartbeats: usize,
    pub metrics_raw: usize,
    pub metrics_hourly: usize,
    pub tokens: usize,
    pub notifications: usize,
    pub monitor_notifications: usize,
    pub status_pages: usize,
    pub status_page_groups: usize,
    pub status_page_monitors: usize,
    pub status_page_incidents: usize,
    pub status_page_cnames: usize,
    pub admin_token: String,
    pub warnings: Vec<String>,
}

/// Import the old database into a fresh one under `data_dir`.
pub async fn run(old_path: &Path, data_dir: &Path, force: bool) -> anyhow::Result<ImportReport> {
    if !old_path.is_file() {
        bail!("old database not found: {}", old_path.display());
    }

    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(old_path)
                .read_only(true),
        )
        .await
        .with_context(|| format!("open old database {}", old_path.display()))?;

    let new = db::connect(data_dir).await?;

    let existing_monitors: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM monitors")
        .fetch_one(&new)
        .await?;
    let existing_tokens: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tokens")
        .fetch_one(&new)
        .await?;
    if (existing_monitors > 0 || existing_tokens > 0) && !force {
        bail!(
            "the new database already has data ({existing_monitors} monitors, {existing_tokens} tokens); \
             delete {} or pass --force to wipe it first",
            data_dir.join("flatline.db").display()
        );
    }
    if force {
        clear(&new).await?;
    }

    let mut report = ImportReport::default();

    import_notifications(&old, &new, &mut report)
        .await
        .context("import notifications")?;
    import_monitors(&old, &new, &mut report)
        .await
        .context("import monitors")?;
    import_monitor_notifications(&old, &new, &mut report)
        .await
        .context("import notification links")?;
    import_tokens(&old, &new, &mut report)
        .await
        .context("import api keys")?;

    let imported_ids: HashSet<i64> = sqlx::query_scalar("SELECT id FROM monitors")
        .fetch_all(&new)
        .await?
        .into_iter()
        .collect();

    import_heartbeats(&old, &new, &imported_ids, &mut report)
        .await
        .context("import heartbeats")?;
    import_metrics(&old, &new, &imported_ids, &mut report)
        .await
        .context("import metrics")?;
    import_status_pages(&old, &new, &imported_ids, &mut report)
        .await
        .context("import status pages")?;

    // Guarantee the operator can sign in even when every imported key's
    // plaintext is lost.
    report.admin_token = auth::mint_admin_token(&new, data_dir).await?;

    Ok(report)
}

/// Wipe the new database's tables in dependency order.
async fn clear(pool: &SqlitePool) -> anyhow::Result<()> {
    for table in [
        "status_page_cnames",
        "status_page_monitors",
        "status_page_groups",
        "status_page_incidents",
        "status_pages",
        "monitor_notifications",
        "notifications",
        "metrics_hourly",
        "metrics_raw",
        "heartbeats",
        "monitors",
        "tokens",
    ] {
        // Dynamic only in an internal constant table name; never user input.
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}")))
            .execute(pool)
            .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Old-schema helpers: the Node schema drifted over time, so columns are
// probed instead of assumed.
// ---------------------------------------------------------------------------

async fn table_exists(pool: &SqlitePool, table: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .bind(table)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
        > 0
}

async fn columns(pool: &SqlitePool, table: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    // Dynamic only in an internal constant table name; quoted because
    // `group` is a reserved word. Never user input.
    if let Ok(rows) = sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA table_info(\"{table}\")"
    )))
    .fetch_all(pool)
    .await
    {
        for row in rows {
            if let Ok(name) = row.try_get::<String, _>("name") {
                set.insert(name);
            }
        }
    }
    set
}

fn text(row: &SqliteRow, cols: &HashSet<String>, name: &str) -> Option<String> {
    if !cols.contains(name) {
        return None;
    }
    row.try_get::<Option<String>, _>(name).ok().flatten()
}

fn text_or(row: &SqliteRow, cols: &HashSet<String>, name: &str, default: &str) -> String {
    text(row, cols, name).unwrap_or_else(|| default.to_string())
}

fn real(row: &SqliteRow, cols: &HashSet<String>, name: &str) -> Option<f64> {
    number(row, cols, name)
}

/// Numbers may be stored as INTEGER or REAL depending on the schema's
/// history (`ping` is INTEGER on this fleet, `timeout` is REAL); accept
/// both.
fn number(row: &SqliteRow, cols: &HashSet<String>, name: &str) -> Option<f64> {
    if !cols.contains(name) {
        return None;
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(name) {
        return value;
    }
    row.try_get::<Option<i64>, _>(name)
        .ok()
        .flatten()
        .map(|value| value as f64)
}

/// Integers that may have been stored as REAL by older schemas.
fn int(row: &SqliteRow, cols: &HashSet<String>, name: &str) -> Option<i64> {
    number(row, cols, name).map(|value| value.round() as i64)
}

fn int_or(row: &SqliteRow, cols: &HashSet<String>, name: &str, default: i64) -> i64 {
    int(row, cols, name).unwrap_or(default)
}

// ---------------------------------------------------------------------------
// Per-table imports
// ---------------------------------------------------------------------------

async fn import_notifications(
    old: &SqlitePool,
    new: &SqlitePool,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if !table_exists(old, "notification").await {
        report
            .warnings
            .push("old database has no `notification` table".to_string());
        return Ok(());
    }
    let cols = columns(old, "notification").await;
    let rows = sqlx::query("SELECT * FROM notification ORDER BY id")
        .fetch_all(old)
        .await?;

    let mut tx = new.begin().await?;
    for row in &rows {
        // Older rows keep the provider type only inside the config JSON.
        let kind = text(row, &cols, "type").unwrap_or_else(|| {
            text(row, &cols, "config")
                .and_then(|config| serde_json::from_str::<serde_json::Value>(&config).ok())
                .and_then(|value| {
                    value
                        .get("type")
                        .and_then(|kind| kind.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "telegram".to_string())
        });

        sqlx::query(
            "INSERT INTO notifications (id, name, type, active, is_default, config)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(int(row, &cols, "id").unwrap_or(0))
        .bind(text_or(row, &cols, "name", ""))
        .bind(kind)
        .bind(int_or(row, &cols, "active", 1))
        .bind(int_or(row, &cols, "is_default", 0))
        .bind(text_or(row, &cols, "config", "{}"))
        .execute(&mut *tx)
        .await?;
        report.notifications += 1;
    }
    tx.commit().await?;
    Ok(())
}

async fn import_monitors(
    old: &SqlitePool,
    new: &SqlitePool,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if !table_exists(old, "monitor").await {
        bail!("old database has no `monitor` table — is this a Flatline database?");
    }
    let cols = columns(old, "monitor").await;
    let rows = sqlx::query("SELECT * FROM monitor ORDER BY id")
        .fetch_all(old)
        .await?;

    let mut tx = new.begin().await?;
    let mut inserted: HashSet<i64> = HashSet::new();
    let mut parents: Vec<(i64, i64)> = Vec::new();

    for row in &rows {
        let name = text_or(row, &cols, "name", "unnamed");
        let kind = text_or(row, &cols, "type", "");
        if !SUPPORTED_TYPES.contains(&kind.as_str()) {
            report.skipped_monitors.push((name, kind));
            continue;
        }

        let id = int(row, &cols, "id").unwrap_or(0);
        // Older rows may predate `created_date`; never bind NULL into the
        // NOT NULL column.
        let created_at = text(row, &cols, "created_date").unwrap_or_else(|| {
            crate::metrics::sql_time_millis(chrono::Utc::now().timestamp_millis())
        });
        // The old schema names this column `accepted_statuscodes_json`; the
        // shorter name is a defensive fallback. Losing it silently would
        // flip monitors that accept 404/403 to DOWN.
        let accepted = text(row, &cols, "accepted_statuscodes_json")
            .or_else(|| text(row, &cols, "accepted_statuscodes"));
        if !cols.contains("accepted_statuscodes_json") && !cols.contains("accepted_statuscodes") {
            report.warnings.push(format!(
                "monitor {id} ({name}): no accepted-status-codes column found; defaulted to 200-299"
            ));
        }
        // Parents are set in a second pass: children routinely have lower
        // ids than the group they hang under.
        sqlx::query(
            "INSERT INTO monitors (
                 id, name, type, active, description, interval, retry_interval, maxretries,
                 timeout, resend_interval, upside_down, parent, weight, url, method,
                 accepted_statuscodes, ignore_tls, maxredirects, push_token,
                 hostname, packet_size, ping_count, ping_numeric, ping_per_request_timeout,
                 metric_cpu_threshold, metric_ram_threshold, metric_disk_threshold, created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(id)
        .bind(name)
        .bind(kind)
        .bind(int_or(row, &cols, "active", 1))
        .bind(text(row, &cols, "description"))
        .bind(int_or(row, &cols, "interval", 60))
        .bind(int_or(row, &cols, "retry_interval", 60))
        .bind(int_or(row, &cols, "maxretries", 0))
        .bind(int_or(row, &cols, "timeout", 48))
        .bind(int_or(row, &cols, "resend_interval", 0))
        .bind(int_or(row, &cols, "upside_down", 0))
        .bind(Option::<i64>::None)
        .bind(int_or(row, &cols, "weight", 0))
        .bind(text(row, &cols, "url"))
        .bind(text(row, &cols, "method"))
        .bind(accepted.unwrap_or_else(|| "[\"200-299\"]".to_string()))
        .bind(int_or(row, &cols, "ignore_tls", 0))
        .bind(int_or(row, &cols, "maxredirects", 10))
        .bind(text(row, &cols, "push_token"))
        .bind(text(row, &cols, "hostname"))
        .bind(int_or(row, &cols, "packet_size", 56))
        .bind(int_or(row, &cols, "ping_count", 1))
        .bind(int_or(row, &cols, "ping_numeric", 1))
        .bind(int_or(row, &cols, "ping_per_request_timeout", 2))
        .bind(int(row, &cols, "metric_cpu_threshold"))
        .bind(int(row, &cols, "metric_ram_threshold"))
        .bind(int(row, &cols, "metric_disk_threshold"))
        .bind(created_at)
        .execute(&mut *tx)
        .await?;

        inserted.insert(id);
        if let Some(parent) = int(row, &cols, "parent") {
            parents.push((id, parent));
        }
        report.monitors += 1;
    }

    for (id, parent) in parents {
        if !inserted.contains(&parent) {
            report.warnings.push(format!(
                "monitor {id}: parent {parent} was not imported; left unparented"
            ));
            continue;
        }
        sqlx::query("UPDATE monitors SET parent = ? WHERE id = ?")
            .bind(parent)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

async fn import_monitor_notifications(
    old: &SqlitePool,
    new: &SqlitePool,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if !table_exists(old, "monitor_notification").await {
        report
            .warnings
            .push("old database has no `monitor_notification` table".to_string());
        return Ok(());
    }
    let cols = columns(old, "monitor_notification").await;
    let rows = sqlx::query("SELECT * FROM monitor_notification")
        .fetch_all(old)
        .await?;

    let mut tx = new.begin().await?;
    for row in &rows {
        // Skip links to monitors or notifications that were not imported.
        let result = sqlx::query(
            "INSERT OR IGNORE INTO monitor_notifications (monitor_id, notification_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM monitors WHERE id = ?)
                        AND EXISTS (SELECT 1 FROM notifications WHERE id = ?)",
        )
        .bind(int(row, &cols, "monitor_id").unwrap_or(0))
        .bind(int(row, &cols, "notification_id").unwrap_or(0))
        .bind(int(row, &cols, "monitor_id").unwrap_or(0))
        .bind(int(row, &cols, "notification_id").unwrap_or(0))
        .execute(&mut *tx)
        .await?;
        report.monitor_notifications += result.rows_affected() as usize;
    }
    tx.commit().await?;
    Ok(())
}

async fn import_tokens(
    old: &SqlitePool,
    new: &SqlitePool,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if !table_exists(old, "api_key").await {
        report
            .warnings
            .push("old database has no `api_key` table".to_string());
        return Ok(());
    }
    let cols = columns(old, "api_key").await;
    let rows = sqlx::query("SELECT * FROM api_key ORDER BY id")
        .fetch_all(old)
        .await?;

    let mut tx = new.begin().await?;
    for row in &rows {
        let hash = text_or(row, &cols, "key", "");
        if hash.is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO tokens (id, name, hash, scheme, active, expires, created_at)
             VALUES (?, ?, ?, 'bcrypt', ?, ?, ?)",
        )
        .bind(int(row, &cols, "id").unwrap_or(0))
        .bind(text_or(row, &cols, "name", "imported"))
        .bind(hash)
        .bind(int_or(row, &cols, "active", 1))
        .bind(text(row, &cols, "expires"))
        .bind(text(row, &cols, "created_date"))
        .execute(&mut *tx)
        .await?;
        report.tokens += 1;
    }
    tx.commit().await?;
    Ok(())
}

async fn import_heartbeats(
    old: &SqlitePool,
    new: &SqlitePool,
    imported_ids: &HashSet<i64>,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if !table_exists(old, "heartbeat").await {
        report
            .warnings
            .push("old database has no `heartbeat` table".to_string());
        return Ok(());
    }
    let cols = columns(old, "heartbeat").await;
    let rows = sqlx::query("SELECT * FROM heartbeat ORDER BY id")
        .fetch_all(old)
        .await?;

    let mut tx = new.begin().await?;
    for row in &rows {
        let monitor_id = int(row, &cols, "monitor_id").unwrap_or(0);
        if !imported_ids.contains(&monitor_id) {
            report.orphan_heartbeats += 1;
            continue;
        }
        sqlx::query(
            "INSERT INTO heartbeats
                 (monitor_id, time, status, ping, msg, important, retries, down_count, duration)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(monitor_id)
        .bind(text_or(row, &cols, "time", ""))
        .bind(int_or(row, &cols, "status", 2))
        .bind(real(row, &cols, "ping"))
        .bind(text(row, &cols, "msg"))
        .bind(int_or(row, &cols, "important", 0))
        .bind(int_or(row, &cols, "retries", 0))
        .bind(int_or(row, &cols, "down_count", 0))
        .bind(int_or(row, &cols, "duration", 0))
        .execute(&mut *tx)
        .await?;
        report.heartbeats += 1;
    }
    tx.commit().await?;
    Ok(())
}

async fn import_metrics(
    old: &SqlitePool,
    new: &SqlitePool,
    imported_ids: &HashSet<i64>,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if table_exists(old, "monitor_metric").await {
        let cols = columns(old, "monitor_metric").await;
        let rows = sqlx::query("SELECT * FROM monitor_metric ORDER BY id")
            .fetch_all(old)
            .await?;
        let mut tx = new.begin().await?;
        for row in &rows {
            let monitor_id = int(row, &cols, "monitor_id").unwrap_or(0);
            if !imported_ids.contains(&monitor_id) {
                continue;
            }
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(text_or(row, &cols, "time", ""))
                .bind(text_or(row, &cols, "payload", "{}"))
                .execute(&mut *tx)
                .await?;
            report.metrics_raw += 1;
        }
        tx.commit().await?;
    } else {
        report
            .warnings
            .push("old database has no `monitor_metric` table".to_string());
    }

    if table_exists(old, "monitor_metric_hourly").await {
        let cols = columns(old, "monitor_metric_hourly").await;
        let rows = sqlx::query("SELECT * FROM monitor_metric_hourly ORDER BY id")
            .fetch_all(old)
            .await?;
        let mut tx = new.begin().await?;
        for row in &rows {
            let monitor_id = int(row, &cols, "monitor_id").unwrap_or(0);
            if !imported_ids.contains(&monitor_id) {
                continue;
            }
            sqlx::query(
                "INSERT INTO metrics_hourly (
                     monitor_id, time,
                     cpu_min, cpu_max, cpu_avg,
                     ram_min, ram_max, ram_avg,
                     gpu_min, gpu_max, gpu_avg,
                     vram_min, vram_max, vram_avg,
                     samples
                 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT (monitor_id, time) DO NOTHING",
            )
            .bind(monitor_id)
            .bind(text_or(row, &cols, "time", ""))
            .bind(real(row, &cols, "cpu_min"))
            .bind(real(row, &cols, "cpu_max"))
            .bind(real(row, &cols, "cpu_avg"))
            .bind(real(row, &cols, "ram_min"))
            .bind(real(row, &cols, "ram_max"))
            .bind(real(row, &cols, "ram_avg"))
            .bind(real(row, &cols, "gpu_min"))
            .bind(real(row, &cols, "gpu_max"))
            .bind(real(row, &cols, "gpu_avg"))
            .bind(real(row, &cols, "vram_min"))
            .bind(real(row, &cols, "vram_max"))
            .bind(real(row, &cols, "vram_avg"))
            .bind(int_or(row, &cols, "samples", 0))
            .execute(&mut *tx)
            .await?;
            report.metrics_hourly += 1;
        }
        tx.commit().await?;
    }
    Ok(())
}

async fn import_status_pages(
    old: &SqlitePool,
    new: &SqlitePool,
    imported_ids: &HashSet<i64>,
    report: &mut ImportReport,
) -> anyhow::Result<()> {
    if !table_exists(old, "status_page").await {
        report
            .warnings
            .push("old database has no `status_page` table".to_string());
        return Ok(());
    }
    let cols = columns(old, "status_page").await;
    let rows = sqlx::query("SELECT * FROM status_page ORDER BY id")
        .fetch_all(old)
        .await?;

    let mut tx = new.begin().await?;
    for row in &rows {
        sqlx::query(
            "INSERT INTO status_pages (
                 id, slug, title, description, icon, theme, accent_color,
                 auto_refresh_interval, published, show_tags, custom_css, footer_text,
                 show_powered_by, analytics_id, analytics_script_url, analytics_type,
                 show_certificate_expiry, show_only_last_heartbeat, rss_title, password, created_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(int(row, &cols, "id").unwrap_or(0))
        .bind(text_or(row, &cols, "slug", "default"))
        .bind(text_or(row, &cols, "title", "Status Page"))
        .bind(text(row, &cols, "description"))
        .bind(text(row, &cols, "icon"))
        .bind(text_or(row, &cols, "theme", "light"))
        .bind(text(row, &cols, "accent_color"))
        .bind(int(row, &cols, "auto_refresh_interval"))
        .bind(int_or(row, &cols, "published", 0))
        .bind(int_or(row, &cols, "show_tags", 0))
        .bind(text(row, &cols, "custom_css"))
        .bind(text(row, &cols, "footer_text"))
        .bind(int_or(row, &cols, "show_powered_by", 0))
        .bind(text(row, &cols, "analytics_id"))
        .bind(text(row, &cols, "analytics_script_url"))
        .bind(text(row, &cols, "analytics_type"))
        .bind(int_or(row, &cols, "show_certificate_expiry", 0))
        .bind(int_or(row, &cols, "show_only_last_heartbeat", 0))
        .bind(text(row, &cols, "rss_title"))
        .bind(text(row, &cols, "password"))
        .bind(text(row, &cols, "created_date").unwrap_or_else(|| {
            crate::metrics::sql_time_millis(chrono::Utc::now().timestamp_millis())
        }))
        .execute(&mut *tx)
        .await?;
        report.status_pages += 1;
    }
    tx.commit().await?;

    // Status-page groups (`group` is a reserved word in SQL).
    if table_exists(old, "group").await {
        let cols = columns(old, "group").await;
        let rows = sqlx::query("SELECT * FROM `group` ORDER BY id")
            .fetch_all(old)
            .await?;
        let mut tx = new.begin().await?;
        for row in &rows {
            sqlx::query(
                "INSERT INTO status_page_groups (id, status_page_id, name, weight, public)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(int(row, &cols, "id").unwrap_or(0))
            .bind(int(row, &cols, "status_page_id").unwrap_or(0))
            .bind(text_or(row, &cols, "name", ""))
            .bind(int_or(row, &cols, "weight", 0))
            .bind(int_or(row, &cols, "public", 1))
            .execute(&mut *tx)
            .await
            .with_context(|| format!("insert group {}", int(row, &cols, "id").unwrap_or(0)))?;
            report.status_page_groups += 1;
        }
        tx.commit().await?;
    }

    if table_exists(old, "monitor_group").await {
        let cols = columns(old, "monitor_group").await;
        let rows = sqlx::query("SELECT * FROM monitor_group")
            .fetch_all(old)
            .await?;
        let mut tx = new.begin().await?;
        for row in &rows {
            let monitor_id = int(row, &cols, "monitor_id").unwrap_or(0);
            if !imported_ids.contains(&monitor_id) {
                report.warnings.push(format!(
                    "status page link for skipped monitor {monitor_id} was not imported"
                ));
                continue;
            }
            sqlx::query(
                "INSERT OR IGNORE INTO status_page_monitors
                     (group_id, monitor_id, send_url, custom_url, weight)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(int(row, &cols, "group_id").unwrap_or(0))
            .bind(monitor_id)
            .bind(int_or(row, &cols, "send_url", 1))
            .bind(text(row, &cols, "custom_url"))
            .bind(int_or(row, &cols, "weight", 0))
            .execute(&mut *tx)
            .await?;
            report.status_page_monitors += 1;
        }
        tx.commit().await?;
    }

    if table_exists(old, "incident").await {
        let cols = columns(old, "incident").await;
        let rows = sqlx::query("SELECT * FROM incident ORDER BY id")
            .fetch_all(old)
            .await?;
        let mut tx = new.begin().await?;
        for row in &rows {
            sqlx::query(
                "INSERT INTO status_page_incidents (
                     id, status_page_id, style, title, content, pin, active,
                     created_date, last_updated_date
                 ) VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .bind(int(row, &cols, "id").unwrap_or(0))
            .bind(int(row, &cols, "status_page_id").unwrap_or(0))
            .bind(text_or(row, &cols, "style", "info"))
            .bind(text_or(row, &cols, "title", ""))
            .bind(text_or(row, &cols, "content", ""))
            .bind(int_or(row, &cols, "pin", 0))
            .bind(int_or(row, &cols, "active", 1))
            .bind(text_or(row, &cols, "created_date", ""))
            .bind(text(row, &cols, "last_updated_date"))
            .execute(&mut *tx)
            .await?;
            report.status_page_incidents += 1;
        }
        tx.commit().await?;
    }

    if table_exists(old, "status_page_cname").await {
        let cols = columns(old, "status_page_cname").await;
        let rows = sqlx::query("SELECT * FROM status_page_cname")
            .fetch_all(old)
            .await?;
        let mut tx = new.begin().await?;
        for row in &rows {
            let domain = text_or(row, &cols, "domain", "");
            if domain.is_empty() {
                continue;
            }
            sqlx::query(
                "INSERT OR IGNORE INTO status_page_cnames (status_page_id, domain) VALUES (?, ?)",
            )
            .bind(int(row, &cols, "status_page_id").unwrap_or(0))
            .bind(domain)
            .execute(&mut *tx)
            .await?;
            report.status_page_cnames += 1;
        }
        tx.commit().await?;
    }

    Ok(())
}

/// CLI entry: `flatline-backend import --from <old.db> [--data-dir ./data] [--force]`.
pub async fn run_cli(args: &[String]) -> anyhow::Result<()> {
    let mut from: Option<PathBuf> = None;
    let mut data_dir: Option<PathBuf> = None;
    let mut force = false;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--from" => {
                from = args.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--data-dir" => {
                data_dir = args.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--force" => {
                force = true;
                index += 1;
            }
            other => bail!("unknown argument: {other}"),
        }
    }

    let from = from.context("--from <old-database> is required")?;
    let data_dir = data_dir.unwrap_or_else(|| PathBuf::from("./data"));

    let report = run(&from, &data_dir, force).await?;

    println!(
        "import complete: {} → {}",
        from.display(),
        data_dir.display()
    );
    println!("  monitors:             {}", report.monitors);
    println!("  heartbeats:           {}", report.heartbeats);
    println!("  metrics (raw):        {}", report.metrics_raw);
    println!("  metrics (hourly):     {}", report.metrics_hourly);
    println!("  api keys:             {}", report.tokens);
    println!("  notifications:        {}", report.notifications);
    println!("  notification links:   {}", report.monitor_notifications);
    println!("  status pages:         {}", report.status_pages);
    println!("  status page groups:   {}", report.status_page_groups);
    println!("  status page monitors: {}", report.status_page_monitors);
    println!("  status page incidents:{}", report.status_page_incidents);
    println!("  status page domains:  {}", report.status_page_cnames);

    if report.orphan_heartbeats > 0 {
        println!(
            "  skipped heartbeats for non-imported monitors: {}",
            report.orphan_heartbeats
        );
    }
    if !report.skipped_monitors.is_empty() {
        println!(
            "\nWARNING: {} monitors were NOT imported (unsupported types):",
            report.skipped_monitors.len()
        );
        for (name, kind) in &report.skipped_monitors {
            println!("  - {name} ({kind})");
        }
        println!("These monitors stop being checked after cutover unless handled.");
    }
    for warning in &report.warnings {
        println!("warning: {warning}");
    }

    println!(
        "\nadmin token (also in {}/initial-token.txt):",
        data_dir.display()
    );
    println!("  {}", report.admin_token);

    Ok(())
}
