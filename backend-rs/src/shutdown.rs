//! Process-wide shutdown signal (A5).
//!
//! One token is shared by everything that must stop on SIGTERM/Ctrl-C: the
//! HTTP server's graceful drain, every SSE stream, the check loops and the
//! engine watchdog. It is a `watch` channel rather than a dependency on
//! `tokio-util`: triggering is idempotent, late subscribers see the
//! triggered state immediately, and waiting is a `'static` future that can
//! be handed to `axum::serve(..).with_graceful_shutdown`.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::watch;

#[derive(Clone)]
pub struct Shutdown {
    tx: Arc<watch::Sender<bool>>,
}

impl Default for Shutdown {
    fn default() -> Self {
        Self::new()
    }
}

impl Shutdown {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(false);
        Self { tx: Arc::new(tx) }
    }

    /// Signal shutdown. Idempotent.
    pub fn trigger(&self) {
        self.tx.send_replace(true);
    }

    pub fn is_triggered(&self) -> bool {
        *self.tx.borrow()
    }

    /// Resolves once shutdown has been triggered (immediately if it already
    /// was). The future owns its receiver, so it can outlive `self`.
    pub fn wait(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut rx = self.tx.subscribe();
        async move {
            // `wait_for` checks the current value first; an error means the
            // sender is gone, which only happens at process teardown.
            let _ = rx.wait_for(|triggered| *triggered).await;
        }
    }
}

/// Ctrl-C or SIGTERM; systemd and `docker stop` send the latter.
pub async fn signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!("install Ctrl-C handler: {error}");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!("install SIGTERM handler: {error}");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

/// Archive the live telemetry the 30 s archive gate has not written yet.
///
/// Live pushes archive one row per 30 s; the newest sample of each monitor
/// usually sits only in the in-memory cache, so every deploy lost up to
/// 30 s of history per agent. On shutdown each cached sample newer than
/// the monitor's last archived one is written (and its rollup hour marked
/// dirty, exactly like the ingest path). Returns the number of rows.
///
/// Kept here, outside `metrics/`, as the narrowest possible hook: it only
/// reads the latest cache and inserts like `Metrics::store` does.
pub async fn flush_live_metrics(metrics: &crate::metrics::Metrics) -> usize {
    let pending: Vec<(i64, String, i64, serde_json::Value)> = {
        let cache = metrics.latest.lock().unwrap();
        cache
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                let time_ms = entry.time_ms?;
                (entry.persisted_sample_time != Some(time_ms))
                    .then(|| (*id, entry.time.clone(), time_ms, entry.metrics.clone()))
            })
            .collect()
    };

    let mut written = 0;
    for (monitor_id, time, time_ms, payload) in pending {
        // Same ordering guarantee as ingest; no push should be running now.
        let _guard = metrics.ingest_guard(monitor_id).await;
        let Ok(encoded) = crate::metrics::validate_metrics(&payload) else {
            continue;
        };
        let inserted =
            sqlx::query("INSERT INTO metrics_raw (monitor_id, time, payload) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(&time)
                .bind(&encoded)
                .execute(&metrics.pool)
                .await;
        match inserted {
            Ok(_) => written += 1,
            Err(error) => {
                tracing::warn!("shutdown: flush telemetry for monitor {monitor_id}: {error}");
                continue;
            }
        }
        let hour = crate::metrics::rollup::hour_start(time_ms);
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO metrics_rollup_dirty (monitor_id, hour) VALUES (?, ?)",
        )
        .bind(monitor_id)
        .bind(crate::metrics::sql_time_millis(hour))
        .execute(&metrics.pool)
        .await;
        // Mark it archived so a second flush is a no-op.
        if let Some(entry) = metrics.latest.lock().unwrap().entries.get_mut(&monitor_id)
            && entry.time_ms == Some(time_ms)
        {
            entry.persisted_sample_time = Some(time_ms);
        }
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn waiters_wake_on_trigger_and_late_waiters_return_immediately() {
        let shutdown = Shutdown::new();
        assert!(!shutdown.is_triggered());

        let early = tokio::spawn(shutdown.wait());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!early.is_finished());

        shutdown.trigger();
        shutdown.trigger();
        tokio::time::timeout(Duration::from_secs(1), early)
            .await
            .expect("an early waiter wakes")
            .unwrap();
        tokio::time::timeout(Duration::from_millis(50), shutdown.wait())
            .await
            .expect("a late waiter returns immediately");
        assert!(shutdown.is_triggered());
    }

    #[tokio::test]
    async fn flush_archives_only_unarchived_live_samples() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::connect(&dir.keep()).await.unwrap();
        let metrics = crate::metrics::Metrics::new(pool.clone(), crate::events::Events::new());
        let (id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        let rows = || async {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM metrics_raw WHERE monitor_id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        };

        // Two live samples 1 s apart: the first archives, the second only
        // reaches the cache (30 s archive gate).
        let now = chrono::Utc::now().timestamp_millis();
        for offset in [2000, 1000] {
            let time = crate::metrics::sql_time_millis(now - offset);
            metrics
                .store(
                    id,
                    &time,
                    &serde_json::json!({ "cpu": { "percent": 5.0 } }),
                    true,
                )
                .await
                .unwrap();
        }
        assert_eq!(rows().await, 1);

        assert_eq!(
            flush_live_metrics(&metrics).await,
            1,
            "the cached sample is written"
        );
        assert_eq!(rows().await, 2);
        assert_eq!(
            flush_live_metrics(&metrics).await,
            0,
            "a second flush is a no-op"
        );
    }
}
