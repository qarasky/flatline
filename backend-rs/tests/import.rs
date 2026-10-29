//! Importer tests: a miniature Node-shaped database is imported and the
//! mapping, skip-reporting and re-run guard are checked.

use std::path::Path;

use flatline_backend::{auth, import};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

/// Build an old (Node/redbean-shaped) database.
async fn old_database(path: &Path) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true),
        )
        .await
        .unwrap();

    for statement in [
        "CREATE TABLE monitor (
            id INTEGER PRIMARY KEY, name VARCHAR(255), type VARCHAR(255), active BOOLEAN,
            description TEXT, interval INTEGER, retry_interval INTEGER, maxretries INTEGER,
            timeout DOUBLE, resend_interval INTEGER, upside_down BOOLEAN, parent INTEGER,
            weight INTEGER, url TEXT, method TEXT, accepted_statuscodes_json TEXT,
            ignore_tls BOOLEAN, maxredirects INTEGER, push_token VARCHAR(255),
            hostname VARCHAR(255), packet_size INTEGER, ping_count INTEGER,
            ping_numeric BOOLEAN, ping_per_request_timeout INTEGER,
            metric_cpu_threshold INTEGER, metric_ram_threshold INTEGER,
            metric_disk_threshold INTEGER, created_date DATETIME )",
        "CREATE TABLE heartbeat (
            id INTEGER PRIMARY KEY, monitor_id INTEGER, time DATETIME, status INTEGER,
            ping DOUBLE, msg TEXT, important BOOLEAN, retries INTEGER, down_count INTEGER,
            duration INTEGER, end_time DATETIME )",
        "CREATE TABLE api_key (
            id INTEGER PRIMARY KEY, user_id INTEGER, key VARCHAR(255), name VARCHAR(255),
            active BOOLEAN, expires DATETIME, created_date DATETIME, scopes TEXT )",
        "CREATE TABLE notification (
            id INTEGER PRIMARY KEY, name VARCHAR(255), active BOOLEAN, is_default BOOLEAN,
            config TEXT )",
        "CREATE TABLE monitor_notification (
            id INTEGER PRIMARY KEY, monitor_id INTEGER, notification_id INTEGER )",
        "CREATE TABLE monitor_metric (
            id INTEGER PRIMARY KEY, monitor_id INTEGER, time DATETIME, payload TEXT )",
        "CREATE TABLE monitor_metric_hourly (
            id INTEGER PRIMARY KEY, monitor_id INTEGER, time DATETIME,
            cpu_min DOUBLE, cpu_max DOUBLE, cpu_avg DOUBLE,
            ram_min DOUBLE, ram_max DOUBLE, ram_avg DOUBLE,
            gpu_min DOUBLE, gpu_max DOUBLE, gpu_avg DOUBLE,
            vram_min DOUBLE, vram_max DOUBLE, vram_avg DOUBLE, samples INTEGER )",
        "CREATE TABLE status_page (
            id INTEGER PRIMARY KEY, slug VARCHAR(255), title VARCHAR(255), description TEXT,
            icon VARCHAR(255), theme VARCHAR(255), auto_refresh_interval INTEGER,
            published BOOLEAN, show_tags BOOLEAN, custom_css TEXT, footer_text TEXT,
            show_powered_by BOOLEAN, analytics_id VARCHAR(255),
            analytics_script_url VARCHAR(255), analytics_type VARCHAR(255),
            show_certificate_expiry BOOLEAN, show_only_last_heartbeat BOOLEAN,
            rss_title VARCHAR(255), password VARCHAR(255), accent_color VARCHAR(255),
            created_date DATETIME )",
        "CREATE TABLE `group` (
            id INTEGER PRIMARY KEY, name VARCHAR(255), weight INTEGER, public BOOLEAN,
            status_page_id INTEGER )",
        "CREATE TABLE monitor_group (
            id INTEGER PRIMARY KEY, monitor_id INTEGER, group_id INTEGER,
            send_url BOOLEAN, custom_url TEXT, weight INTEGER )",
        "CREATE TABLE incident (
            id INTEGER PRIMARY KEY, status_page_id INTEGER, style VARCHAR(255),
            title VARCHAR(255), content TEXT, pin BOOLEAN, active BOOLEAN,
            created_date DATETIME, last_updated_date DATETIME )",
        "CREATE TABLE status_page_cname (
            id INTEGER PRIMARY KEY, status_page_id INTEGER, domain VARCHAR(255) )",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }

    // Group 18 holds children with lower ids (the production shape).
    sqlx::query("INSERT INTO monitor (id, name, type, active, interval, timeout) VALUES (18, 'bes.media', 'group', 1, 60, 48)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO monitor (id, name, type, active, interval, timeout, parent, url, method, accepted_statuscodes_json, maxretries) VALUES (8, 'bes.media', 'http', 1, 60, 48.0, 18, 'https://bes.media', 'GET', '[\"200-299\",\"404\"]', 3)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO monitor (id, name, type, active, interval, timeout, parent, push_token) VALUES (46, 'aiel-qorgan', 'push', 1, 180, 144, 18, 'e3STnnoFE_UMX1h6N1o7REA_THF9IIxL')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO monitor (id, name, type, active, interval, timeout, parent, hostname, ping_count, packet_size, ping_numeric, ping_per_request_timeout) VALUES (12, 'bes.media server', 'ping', 1, 60, 10, 18, '46.62.149.85', 3, 56, 1, 2)")
        .execute(&pool)
        .await
        .unwrap();
    // A legacy row with timeout 0: the importer normalizes it to 80% of the
    // interval, like the Node migration and runtime patch do.
    sqlx::query("INSERT INTO monitor (id, name, type, active, interval, timeout) VALUES (55, 'legacy-zero', 'push', 1, 60, 0)")
        .execute(&pool)
        .await
        .unwrap();

    for (monitor_id, status, ping) in [
        (8_i64, 1_i64, Some(42.0_f64)),
        (46, 1, None),
        (12, 1, Some(5.0)),
    ] {
        sqlx::query("INSERT INTO heartbeat (monitor_id, time, status, ping, important) VALUES (?, '2026-10-12 20:00:00', ?, ?, 0)")
            .bind(monitor_id)
            .bind(status)
            .bind(ping)
            .execute(&pool)
            .await
            .unwrap();
    }

    let key_hash = bcrypt::hash("uk7_secret", 4).unwrap();
    sqlx::query("INSERT INTO api_key (id, user_id, key, name, active, expires, created_date, scopes) VALUES (7, 1, ?, 'ci-runner', 1, NULL, '2026-10-01 10:00:00', 'read')")
        .bind(&key_hash)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO notification (id, name, active, is_default, config) VALUES (1, 'MBG Alerts', 1, 1, '{\"type\":\"telegram\",\"telegramChatID\":\"-100\"}')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (8, 1)")
        .execute(&pool)
        .await
        .unwrap();
    // A link for the skipped ping monitor: reported, never inserted.
    sqlx::query("INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (12, 1)")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO monitor_metric (monitor_id, time, payload) VALUES (46, '2026-10-12 20:00:00', '{\"cpu\":{\"percent\":10}}')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO monitor_metric_hourly (monitor_id, time, cpu_min, cpu_max, cpu_avg, samples) VALUES (46, '2026-10-12 19:00:00', 5, 15, 10, 120)")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO status_page (id, slug, title, published, show_tags) VALUES (1, 'clients', 'Media Boost Group', 1, 0)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO `group` (id, name, weight, public, status_page_id) VALUES (4, 'Bes.media', 3, 1, 1)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO monitor_group (monitor_id, group_id, send_url, weight) VALUES (8, 4, 0, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO monitor_group (monitor_id, group_id, send_url, weight) VALUES (12, 4, 0, 2)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO incident (id, status_page_id, title, content, pin, active, created_date) VALUES (5, 1, 'Pinned', 'body', 1, 1, '2026-10-01 10:00:00')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO status_page_cname (status_page_id, domain) VALUES (1, 'status.bes.media')",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

#[tokio::test]
async fn imports_the_production_shape() {
    let dir = tempfile::tempdir().unwrap();
    let old_path = dir.path().join("old.db");
    let old = old_database(&old_path).await;
    old.close().await;

    let data_dir = dir.path().join("data");
    let report = import::run(&old_path, &data_dir, false).await.unwrap();

    assert_eq!(
        report.monitors, 5,
        "http + push + group + ping + legacy zero-timeout"
    );
    assert!(
        report.skipped_monitors.is_empty(),
        "{:?}",
        report.skipped_monitors
    );
    assert_eq!(report.heartbeats, 3);
    assert_eq!(report.orphan_heartbeats, 0);
    assert_eq!(report.metrics_raw, 1);
    assert_eq!(report.metrics_hourly, 1);
    assert_eq!(report.tokens, 1);
    assert_eq!(report.notifications, 1);
    assert_eq!(report.monitor_notifications, 2);
    assert_eq!(report.status_pages, 1);
    assert_eq!(report.status_page_groups, 1);
    assert_eq!(report.status_page_monitors, 2);
    assert_eq!(report.status_page_incidents, 1);
    assert_eq!(report.status_page_cnames, 1);
    assert!(report.admin_token.starts_with("flatline_"));
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);

    let new = flatline_backend::db::connect(&data_dir).await.unwrap();

    // Parent links survive the out-of-order ids.
    let parent: Option<i64> = sqlx::query_scalar("SELECT parent FROM monitors WHERE id = 8")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(parent, Some(18));
    let (hostname, ping_count): (Option<String>, i64) =
        sqlx::query_as("SELECT hostname, ping_count FROM monitors WHERE id = 12")
            .fetch_one(&new)
            .await
            .unwrap();
    assert_eq!(hostname.as_deref(), Some("46.62.149.85"));
    assert_eq!(ping_count, 3);
    let accepted: String =
        sqlx::query_scalar("SELECT accepted_statuscodes FROM monitors WHERE id = 8")
            .fetch_one(&new)
            .await
            .unwrap();
    assert_eq!(
        accepted, "[\"200-299\",\"404\"]",
        "old-schema column name is honored"
    );
    let push_token: String = sqlx::query_scalar("SELECT push_token FROM monitors WHERE id = 46")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(push_token, "e3STnnoFE_UMX1h6N1o7REA_THF9IIxL");

    // A zero timeout imports as 80% of the interval in seconds, never as
    // milliseconds or zero.
    let legacy_timeout: i64 = sqlx::query_scalar("SELECT timeout FROM monitors WHERE id = 55")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(legacy_timeout, 48);

    // Imported API keys still verify through the real auth path.
    assert!(matches!(
        auth::verify_token(&new, "uk7_secret").await,
        Ok(auth::TokenVerdict::Operator(_))
    ));
    assert_eq!(
        auth::verify_token(&new, "wrong").await,
        Ok(auth::TokenVerdict::Invalid)
    );
    let scheme: String = sqlx::query_scalar("SELECT scheme FROM tokens WHERE id = 7")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(scheme, "bcrypt");

    // Status page data round-trips.
    let page = flatline_backend::status_pages::load(&new, "clients")
        .await
        .unwrap()
        .unwrap();
    let data = flatline_backend::status_pages::page_data(&new, &page)
        .await
        .unwrap();
    assert_eq!(data["config"]["title"], "Media Boost Group");
    assert_eq!(data["publicGroupList"][0]["monitorList"][0]["id"], 8);
    assert_eq!(data["incidents"][0]["title"], "Pinned");
    assert_eq!(
        flatline_backend::status_pages::resolve_host(&new, "status.bes.media")
            .await
            .unwrap()
            .as_deref(),
        Some("clients")
    );

    // Re-running without --force refuses; --force wipes and re-imports.
    assert!(import::run(&old_path, &data_dir, false).await.is_err());
    let second = import::run(&old_path, &data_dir, true).await.unwrap();
    assert_eq!(second.monitors, 5);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM monitors")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(count, 5, "no duplicates after --force");

    // The old database was opened read-only and never modified.
    let old_again = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&old_path)
                .read_only(true),
        )
        .await
        .unwrap();
    let monitors: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM monitor")
        .fetch_one(&old_again)
        .await
        .unwrap();
    assert_eq!(monitors, 5);
}

#[tokio::test]
async fn import_is_atomic_pages_large_tables_and_skips_bad_times() {
    let dir = tempfile::tempdir().unwrap();
    let old_path = dir.path().join("old.db");
    let old = old_database(&old_path).await;

    // More heartbeats than one importer page, so paging must carry on.
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
         INSERT INTO heartbeat (monitor_id, time, status, important)
         SELECT 46, '2026-10-12 20:00:00', 1, 0 FROM n",
    )
    .execute(&old)
    .await
    .unwrap();
    // Metric rows without a usable time: the old default of '' made the
    // rollup stop forever. They are skipped and reported.
    for time in ["NULL", "''", "'not a time'"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO monitor_metric (monitor_id, time, payload) VALUES (46, {time}, '{{}}')"
        )))
        .execute(&old)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO monitor_metric_hourly (monitor_id, time, samples) VALUES (46, NULL, 1)",
    )
    .execute(&old)
    .await
    .unwrap();

    let data_dir = dir.path().join("data");
    let report = import::run(&old_path, &data_dir, false).await.unwrap();
    assert_eq!(report.heartbeats, 12003, "every page is imported");
    assert_eq!(report.metrics_raw, 1);
    assert_eq!(report.metrics_hourly, 1);
    assert_eq!(report.bad_time_metrics, 4);
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("unparseable time")),
        "{:?}",
        report.warnings
    );

    let new = flatline_backend::db::connect(&data_dir).await.unwrap();
    let blank: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_raw WHERE time = ''")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(blank, 0);

    // Rollup state from the wiped data must not survive a --force import:
    // the next rollup has to reconcile the imported window in full.
    sqlx::query("INSERT INTO metrics_rollup_state (name, value) VALUES ('repair_cursor', '2026-10-12 00:00:00.000')")
        .execute(&new)
        .await
        .unwrap();
    import::run(&old_path, &data_dir, true).await.unwrap();
    let state: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metrics_rollup_state")
        .fetch_one(&new)
        .await
        .unwrap();
    assert_eq!(state, 0, "clear() resets the rollup state");

    // A failure part-way (a status-page group pointing at a missing page
    // violates a foreign key, after monitors and heartbeats were written)
    // leaves the database exactly as it was: the wipe rolls back too.
    sqlx::query("INSERT INTO `group` (id, name, weight, public, status_page_id) VALUES (9, 'broken', 1, 1, 999)")
        .execute(&old)
        .await
        .unwrap();
    old.close().await;
    let before: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM monitors), (SELECT COUNT(*) FROM heartbeats),
                (SELECT COUNT(*) FROM tokens)",
    )
    .fetch_one(&new)
    .await
    .unwrap();
    assert!(import::run(&old_path, &data_dir, true).await.is_err());
    let after: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM monitors), (SELECT COUNT(*) FROM heartbeats),
                (SELECT COUNT(*) FROM tokens)",
    )
    .fetch_one(&new)
    .await
    .unwrap();
    assert_eq!(before, after, "a failed import is all-or-nothing");
    assert_eq!(after.0, 5);
}
