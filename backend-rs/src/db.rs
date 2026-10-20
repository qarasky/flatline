use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

/// Upper bound the WAL file is truncated back to after a checkpoint, in
/// bytes. Without it the `-wal` file stays at its peak size forever (a large
/// delete or an import leaves hundreds of MB behind).
pub const JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

/// Open (creating when missing) the SQLite database and run migrations.
///
/// WAL mode and a busy timeout: the importer may run against a copy while
/// the live database keeps serving, and short write bursts must not fail.
///
/// `synchronous = NORMAL` is the documented safe setting for WAL: a commit
/// is durable once the WAL is synced at checkpoint, and a power loss can at
/// worst roll back the last few commits — never corrupt the database. FULL
/// fsyncs on every commit, which at 1 Hz telemetry from a fleet is most of
/// the write path's cost and lengthens every write-lock hold.
pub async fn connect(data_dir: &Path) -> anyhow::Result<SqlitePool> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("create data dir {}", data_dir.display()))?;

    let options = SqliteConnectOptions::new()
        .filename(data_dir.join("flatline.db"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .synchronous(SqliteSynchronous::Normal)
        .pragma("journal_size_limit", JOURNAL_SIZE_LIMIT_BYTES.to_string())
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .context("open sqlite database")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run migrations")?;

    Ok(pool)
}

/// Rows deleted per statement when clearing a monitor's history.
pub const DELETE_BATCH: i64 = 2000;
/// Pause between delete batches, so waiting writers get the lock.
const DELETE_BATCH_PAUSE: Duration = Duration::from_millis(5);

/// Delete a monitor's telemetry and heartbeats in bounded batches.
///
/// Called before the monitor row itself is deleted: the `ON DELETE CASCADE`
/// alone removed ~86k raw and ~17k hourly rows per monitor (more for a
/// group) in one statement, holding the write lock for the whole cascade.
/// Each batch here is its own short transaction on a `monitor_id` index.
/// Rows written while this runs are left to the final cascade, which then
/// only has seconds of data to remove. Returns the rows deleted.
pub async fn delete_monitor_history(pool: &SqlitePool, monitor_id: i64) -> sqlx::Result<u64> {
    let mut deleted = 0;
    for table in [
        "metrics_raw",
        "metrics_hourly",
        "metrics_rollup_dirty",
        "heartbeats",
    ] {
        // Dynamic only in an internal constant table name; never user input.
        let sql = format!(
            "DELETE FROM {table} WHERE id IN (SELECT id FROM {table} WHERE monitor_id = ? LIMIT ?)"
        );
        loop {
            let result = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
                .bind(monitor_id)
                .bind(DELETE_BATCH)
                .execute(pool)
                .await?;
            deleted += result.rows_affected();
            if (result.rows_affected() as i64) < DELETE_BATCH {
                break;
            }
            tokio::time::sleep(DELETE_BATCH_PAUSE).await;
        }
    }
    Ok(deleted)
}
