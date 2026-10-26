//! Flatline backend.
//!
//! The monitor surface is deliberately small — push, http(s), ping and group
//! containers — plus the telemetry pipeline, the Superboard read APIs, badges
//! and single-token auth. The Go agent and the SPA are reused unchanged.

// monitor_json builds one large json! literal; the default macro recursion
// limit is too small once it carries the token-family fields.
#![recursion_limit = "256"]
//! Architecture: docs/architecture.md.

pub mod api;
pub mod auth;
pub mod backups;
pub mod badges;
pub mod config;
pub mod db;
pub mod device;
pub mod events;
pub mod heartbeats;
pub mod import;
pub mod links;
pub mod metrics;
pub mod monitors;
pub mod mutes;
pub mod notify;
pub mod shutdown;
pub mod status_pages;

use std::sync::Arc;

use axum::Router;
use axum::serve::ListenerExt;
use sqlx::SqlitePool;

/// Shared application state handed to every handler.
#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<config::Config>,
    pub events: Arc<events::Events>,
    pub engine: Arc<monitors::engine::Engine>,
    pub metrics: Arc<metrics::Metrics>,
    /// Named backup agents, credentials and run metadata. Bundle storage is
    /// enabled only when `FLATLINE_BACKUP_DIR` points at a provisioned root.
    pub backups: Arc<backups::Backups>,
    /// Signing secret for status-page unlock cookies (owner-only file).
    pub status_page_secret: Arc<String>,
    /// Short-lived cache behind `GET /api/v1/monitors/heartbeat-strips`.
    pub strips: Arc<api::strips::StripCache>,
    /// Pending QR sign-in requests (in memory; see `device`).
    pub devices: Arc<device::DeviceRequests>,
}

/// Open the database, run migrations, and make sure an admin token exists.
pub async fn build_state(config: config::Config) -> anyhow::Result<AppState> {
    let pool = db::connect(&config.data_dir).await?;

    if let Some(token) = auth::ensure_initial_token(&pool, &config.data_dir).await? {
        tracing::info!(
            "first boot: admin token written to {}/initial-token.txt",
            config.data_dir.display()
        );
        tracing::info!("admin token: {token}");
    }

    let events = events::Events::new();
    let engine = monitors::engine::Engine::new(pool.clone(), Arc::clone(&events));
    let metrics = metrics::Metrics::new(pool.clone(), Arc::clone(&events));
    let config = Arc::new(config);
    let backups = backups::Backups::new(pool.clone(), Arc::clone(&config), Arc::clone(&events));
    let status_page_secret = status_pages::ensure_secret(&config.data_dir)?;

    Ok(AppState {
        pool,
        config,
        events,
        engine,
        metrics,
        backups,
        status_page_secret: Arc::new(status_page_secret),
        strips: Arc::new(api::strips::StripCache::new()),
        devices: Arc::new(device::DeviceRequests::new()),
    })
}

/// Build the HTTP router for a state (public for integration tests).
pub fn router(state: AppState) -> Router {
    api::router(state)
}

/// How long the HTTP server may drain after the shutdown signal. SSE
/// streams end on the token at once; this bounds ordinary requests.
const HTTP_DRAIN: std::time::Duration = std::time::Duration::from_secs(3);
/// Queued alerts are delivered until this long after the signal.
const NOTIFY_DRAIN: std::time::Duration = std::time::Duration::from_secs(12);
/// Bounds for the final telemetry flush and the pool close.
const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Boot the server: config, database, HTTP listener, graceful shutdown.
///
/// Shutdown (A5), on SIGTERM or Ctrl-C, worst case about 16 s (compose
/// grants 30 s before SIGKILL):
///
/// 1. the shared token fires: SSE streams end, the server stops accepting
///    and drains for at most [`HTTP_DRAIN`]; meanwhile check loops stop
///    (at most 2 s), backup jobs and upload bodies are cancelled, and the
///    metrics jobs are aborted (rollups are
///    idempotent upserts, so an interrupted run is redone next hour);
/// 2. queued alerts are delivered until [`NOTIFY_DRAIN`] after the signal;
/// 3. unarchived live telemetry is flushed ([`FLUSH_TIMEOUT`]);
/// 4. the pool is closed ([`CLOSE_TIMEOUT`]).
pub async fn run() -> anyhow::Result<()> {
    let config = config::Config::from_env()?;
    let address = format!("{}:{}", config.host, config.port);

    let state = build_state(config).await?;
    let token = state.engine.shutdown_token();
    notify::install_global(Some(Arc::clone(state.engine.notifier())));
    state.engine.start_all().await;
    let jobs = state
        .metrics
        .start_jobs(state.config.heartbeat_retention_days);

    // Finish interrupted uploads/finalizations/deletions before the listener
    // accepts new work, then run maintenance and health every minute.
    // A backup mount problem must never prevent monitoring from starting.
    if let Err(error) = state
        .backups
        .reconcile(chrono::Utc::now().timestamp_millis())
        .await
    {
        tracing::error!("backup reconciliation deferred: {error}");
    }
    // The backup maintenance loop and in-flight upload bodies stop on
    // `Backups::shutdown`, called from the shared shutdown sequence below.
    state
        .backups
        .start_jobs(tokio_util::sync::CancellationToken::new());

    let listener = tokio::net::TcpListener::bind(&address)
        .await?
        .tap_io(enable_keepalive);
    tracing::info!("flatline-rs listening on {address}");

    {
        let token = token.clone();
        tokio::spawn(async move {
            shutdown::signal().await;
            tracing::info!("shutting down");
            token.trigger();
        });
    }

    let serve = {
        let app = router(state.clone());
        let drained = token.wait();
        async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(drained)
                .await
        }
    };
    tokio::pin!(serve);

    let early = tokio::select! {
        result = &mut serve => Some(result),
        _ = token.wait() => None,
    };
    // A server error ends the process the same orderly way.
    token.trigger();
    state.backups.shutdown();
    let signalled = tokio::time::Instant::now();
    for job in &jobs {
        job.abort();
    }

    let served = match early {
        Some(result) => {
            state.engine.stop_checks().await;
            result
        }
        None => {
            let (_, drained) = tokio::join!(
                state.engine.stop_checks(),
                tokio::time::timeout(HTTP_DRAIN, &mut serve)
            );
            drained.unwrap_or_else(|_| {
                tracing::warn!(
                    "shutdown: connections still open after {}s; closing them",
                    HTTP_DRAIN.as_secs()
                );
                Ok(())
            })
        }
    };

    state
        .engine
        .notifier()
        .shutdown(signalled + NOTIFY_DRAIN)
        .await;
    notify::install_global(None);

    match tokio::time::timeout(FLUSH_TIMEOUT, shutdown::flush_live_metrics(&state.metrics)).await {
        Ok(0) => {}
        Ok(rows) => tracing::info!("shutdown: archived {rows} live telemetry samples"),
        Err(_) => tracing::warn!("shutdown: telemetry flush timed out"),
    }

    if tokio::time::timeout(CLOSE_TIMEOUT, state.pool.close())
        .await
        .is_err()
    {
        tracing::warn!("shutdown: database pool close timed out");
    }
    tracing::info!("shutdown complete in {}ms", signalled.elapsed().as_millis());

    served?;
    Ok(())
}

/// TCP keepalive on every accepted connection, so a peer that vanished
/// without a FIN (a half-open backup upload, a dropped SSE client) is
/// detected by the kernel in minutes rather than hours. Best-effort.
fn enable_keepalive(stream: &mut tokio::net::TcpStream) {
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(60))
        .with_interval(std::time::Duration::from_secs(15));
    if let Err(error) = socket2::SockRef::from(&*stream).set_tcp_keepalive(&keepalive) {
        tracing::debug!("tcp keepalive not enabled: {error}");
    }
}
