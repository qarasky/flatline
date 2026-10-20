//! Flatline backend.
//!
//! The monitor surface is deliberately small — push, http(s), ping and group
//! containers — plus the telemetry pipeline, the Superboard read APIs, badges
//! and single-token auth. The Go agent and the SPA are reused unchanged.
//! Architecture: docs/architecture.md.

pub mod api;
pub mod auth;
pub mod backups;
pub mod badges;
pub mod config;
pub mod db;
pub mod events;
pub mod heartbeats;
pub mod import;
pub mod links;
pub mod metrics;
pub mod monitors;
pub mod notify;
pub mod status_pages;

use std::sync::Arc;

use axum::Router;
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
    })
}

/// Build the HTTP router for a state (public for integration tests).
pub fn router(state: AppState) -> Router {
    api::router(state)
}

/// Boot the server: config, database, HTTP listener, graceful shutdown.
pub async fn run() -> anyhow::Result<()> {
    let config = config::Config::from_env();
    let address = format!("{}:{}", config.host, config.port);

    let state = build_state(config).await?;
    state.engine.start_all().await;
    state
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
    // Integration point: pass the shared shutdown token here once lib.rs
    // has one; until then the jobs run for the life of the process.
    state
        .backups
        .start_jobs(tokio_util::sync::CancellationToken::new());

    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!("flatline-rs listening on {address}");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Ctrl-C or SIGTERM; systemd and `docker stop` send the latter.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
