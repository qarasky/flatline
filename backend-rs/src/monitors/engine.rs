//! Check engine: HTTP scheduling, push-timeout watching, heartbeat
//! recording, live publishing and notification dispatch.
//!
//! One tokio task per active monitor, started at boot and restarted when
//! the API edits a monitor. The transition rules live in
//! `crate::heartbeats`; this module owns the timers and the side effects.
//!
//! Before [`Engine::start_all`] runs (integration tests), the engine is
//! inert: recording still works, no check loops are spawned.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::events::Events;
use crate::heartbeats::{self, Beat, DOWN, PENDING, UP};
use crate::monitors::Monitor;
use crate::notify;

/// Uptime ratios change slowly; recomputing at most every 30s keeps the
/// monitor list and the SSE patch cheap.
const UPTIME_TTL: Duration = Duration::from_secs(30);

pub struct Engine {
    pool: SqlitePool,
    events: Arc<Events>,
    /// Check clients differ per monitor (TLS tolerance, redirect cap), so
    /// they are cached by those two knobs instead of rebuilt per check.
    clients: Mutex<HashMap<(bool, i64), reqwest::Client>>,
    notify_client: reqwest::Client,
    tasks: Mutex<HashMap<i64, JoinHandle<()>>>,
    running: AtomicBool,
    /// Wait a full interval before the first push-timeout check. Node does
    /// this so a backend restart cannot page while a live agent's next
    /// push is still in flight. Tests skip it to stay fast.
    boot_delay_push: bool,
    uptime: Mutex<HashMap<i64, (Instant, heartbeats::UptimeWindows)>>,
}

impl Engine {
    pub fn new(pool: SqlitePool, events: Arc<Events>) -> Arc<Self> {
        Self::build(pool, events, true)
    }

    /// Test seam: push watchers skip the initial interval-long wait so
    /// timeout behavior can be exercised quickly. Production uses [`Self::new`].
    pub fn for_tests(pool: SqlitePool, events: Arc<Events>) -> Arc<Self> {
        Self::build(pool, events, false)
    }

    fn build(pool: SqlitePool, events: Arc<Events>, boot_delay_push: bool) -> Arc<Self> {
        Arc::new(Self {
            pool,
            events,
            clients: Mutex::new(HashMap::new()),
            notify_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            tasks: Mutex::new(HashMap::new()),
            running: AtomicBool::new(false),
            boot_delay_push,
            uptime: Mutex::new(HashMap::new()),
        })
    }

    /// Boot: one task per active monitor.
    pub async fn start_all(self: &Arc<Self>) {
        self.running.store(true, Ordering::SeqCst);

        let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM monitors WHERE active = 1")
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        for id in ids {
            self.restart(id).await;
        }
    }

    /// (Re)start the task for one monitor; a no-op for groups, inactive
    /// monitors, and while the engine is inert.
    pub async fn restart(self: &Arc<Self>, id: i64) {
        if !self.running.load(Ordering::SeqCst) {
            return;
        }
        self.stop(id);

        let monitor = match sqlx::query_as::<_, Monitor>("SELECT * FROM monitors WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
        {
            Ok(Some(monitor)) => monitor,
            Ok(None) => return,
            Err(error) => {
                tracing::error!("engine: load monitor {id}: {error}");
                return;
            }
        };

        if monitor.active == 0 {
            return;
        }

        let engine = Arc::clone(self);
        let handle = match monitor.kind.as_str() {
            "http" | "https" => tokio::spawn(async move { engine.http_loop(monitor).await }),
            "push" => tokio::spawn(async move { engine.push_loop(monitor).await }),
            _ => return,
        };
        self.tasks.lock().unwrap().insert(id, handle);
    }

    /// Stop the task for a monitor (deleted, paused, or restarted).
    pub fn stop(&self, id: i64) {
        if let Some(handle) = self.tasks.lock().unwrap().remove(&id) {
            handle.abort();
        }
    }

    /// Record a heartbeat, publish it live, and fire notifications when the
    /// transition (or a resend) calls for one. Used by the push endpoint.
    pub async fn record_heartbeat(
        self: &Arc<Self>,
        monitor: &Monitor,
        requested: i64,
        ping: Option<f64>,
        msg: &str,
        explicit_down: bool,
    ) -> sqlx::Result<heartbeats::Recorded> {
        self.record_and_publish(monitor, requested, ping, msg, explicit_down, None)
            .await
    }

    /// Uptime ratios with a short TTL: the monitor list and the SSE patch
    /// both read them, and a 30-day scan per read would be wasteful.
    pub async fn uptime_windows(&self, monitor_id: i64) -> heartbeats::UptimeWindows {
        {
            let cache = self.uptime.lock().unwrap();
            if let Some((at, windows)) = cache.get(&monitor_id)
                && at.elapsed() < UPTIME_TTL
            {
                return *windows;
            }
        }

        let windows = heartbeats::uptime_windows(&self.pool, monitor_id)
            .await
            .unwrap_or_default();
        self.uptime
            .lock()
            .unwrap()
            .insert(monitor_id, (Instant::now(), windows));
        windows
    }

    /// The HTTP check loop: check immediately (like the Node backend), then
    /// every interval — or every retry interval while the walk is PENDING.
    async fn http_loop(self: Arc<Self>, monitor: Monitor) {
        loop {
            let (requested, ping, msg) = match self.http_check(&monitor).await {
                Ok((ping, msg)) => (UP, Some(ping), msg),
                Err(message) => (DOWN, None, message),
            };

            let status = match self
                .record_and_publish(&monitor, requested, ping, &msg, false, None)
                .await
            {
                Ok(recorded) => recorded.beat.status,
                Err(error) => {
                    tracing::error!("engine: heartbeat for {}: {error}", monitor.name);
                    DOWN
                }
            };

            let base = match status {
                PENDING => monitor.retry_interval.max(1),
                _ => monitor.interval.max(1),
            };
            tokio::time::sleep(Duration::from_secs(base as u64)).await;
        }
    }

    /// The push watcher: fail when no heartbeat lands inside
    /// `interval + 1s` (Node's buffer for clock differences), otherwise
    /// reschedule just past the next expected beat. Successful pushes are
    /// recorded by the push endpoint, never here.
    async fn push_loop(self: Arc<Self>, monitor: Monitor) {
        let interval_ms = monitor.interval.max(1) * 1000;

        if self.boot_delay_push {
            // Node delays the first push check by a full interval.
            tokio::time::sleep(Duration::from_secs(monitor.interval.max(1) as u64)).await;
        }

        loop {
            let latest = heartbeats::latest(&self.pool, monitor.id)
                .await
                .ok()
                .flatten();
            let expected_up = if monitor.upside_down != 0 { DOWN } else { UP };

            match latest {
                Some(beat)
                    if beat.status == expected_up
                        && heartbeats::millis_since(&beat.time)
                            .map(|ms| ms <= interval_ms + 1000)
                            .unwrap_or(false) =>
                {
                    let since = heartbeats::millis_since(&beat.time).unwrap_or(0);
                    let wait = (interval_ms - since).max(0) + 1000;
                    tokio::time::sleep(Duration::from_millis(wait as u64)).await;
                }
                other => {
                    let duration = other
                        .as_ref()
                        .and_then(|beat| heartbeats::millis_since(&beat.time))
                        .map(|ms| (ms + 500) / 1000)
                        .unwrap_or(monitor.interval.max(1));

                    let status = match self
                        .record_and_publish(
                            &monitor,
                            DOWN,
                            None,
                            "No heartbeat in the time window",
                            false,
                            Some(duration),
                        )
                        .await
                    {
                        Ok(recorded) => recorded.beat.status,
                        Err(error) => {
                            tracing::error!("engine: push timeout for {}: {error}", monitor.name);
                            DOWN
                        }
                    };

                    let base = match status {
                        PENDING => monitor.retry_interval.max(1),
                        _ => monitor.interval.max(1),
                    };
                    tokio::time::sleep(Duration::from_secs(base as u64)).await;
                }
            }
        }
    }

    /// Record, publish, notify — the shared tail of every check path.
    async fn record_and_publish(
        self: &Arc<Self>,
        monitor: &Monitor,
        requested: i64,
        ping: Option<f64>,
        msg: &str,
        explicit_down: bool,
        duration_override: Option<i64>,
    ) -> sqlx::Result<heartbeats::Recorded> {
        let recorded = heartbeats::record(
            &self.pool,
            monitor,
            requested,
            ping,
            msg,
            explicit_down,
            duration_override,
        )
        .await?;

        self.publish_heartbeat(monitor, &recorded.beat).await;

        if recorded.notify {
            self.dispatch_notification(monitor, &recorded.beat);
        }

        Ok(recorded)
    }

    /// SSE `heartbeat` event, shaped like the Node live update.
    async fn publish_heartbeat(self: &Arc<Self>, monitor: &Monitor, beat: &Beat) {
        let uptime = self.uptime_windows(monitor.id).await;
        self.events.publish(json!({
            "type": "heartbeat",
            "monitorId": monitor.id,
            "patch": {
                "status": beat.status,
                "ping": beat.ping,
                "lastCheck": beat.time,
                "lastMessage": beat.msg,
                "uptime24h": uptime.day,
                "uptime7d": uptime.week,
                "uptime30d": uptime.month,
            }
        }));
    }

    /// Telegram alerts, spawned so a slow bot API never delays a beat.
    fn dispatch_notification(self: &Arc<Self>, monitor: &Monitor, beat: &Beat) {
        let pool = self.pool.clone();
        let client = self.notify_client.clone();
        let monitor_id = monitor.id;
        let monitor_name = monitor.name.clone();
        let status = beat.status;
        let msg = beat
            .msg
            .clone()
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "N/A".to_string());

        tokio::spawn(async move {
            let rows = match notify::linked(&pool, monitor_id).await {
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
                let Some(telegram) = notify::parse_telegram(&config) else {
                    tracing::warn!("notify: {name} has no usable telegram config");
                    continue;
                };
                let text = notify::heartbeat_message(&monitor_name, status, &msg);
                if let Err(error) = notify::send_telegram(&client, &telegram, &text).await {
                    tracing::error!("notify: telegram send for {name} failed: {error}");
                }
            }
        });
    }

    /// One HTTP check. `Ok((ping_ms, message))` means UP.
    async fn http_check(&self, monitor: &Monitor) -> Result<(f64, String), String> {
        let url = monitor
            .url
            .as_deref()
            .filter(|url| !url.is_empty())
            .ok_or_else(|| "No URL configured".to_string())?;

        let raw_method = monitor
            .method
            .as_deref()
            .filter(|method| !method.is_empty())
            .unwrap_or("GET");
        let method = reqwest::Method::from_bytes(raw_method.to_uppercase().as_bytes())
            .map_err(|_| format!("Invalid HTTP method: {raw_method}"))?;

        // Node patches a zero timeout at runtime to 80% of the interval.
        let timeout = if monitor.timeout > 0 {
            monitor.timeout
        } else {
            ((monitor.interval as f64) * 0.8).floor() as i64
        };

        let client = self.client_for(monitor.ignore_tls != 0, monitor.maxredirects);
        let started = Instant::now();
        let response = client
            .request(method, url)
            .timeout(Duration::from_secs(timeout.max(1) as u64))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    format!("timeout of {}ms exceeded", timeout.max(1) * 1000)
                } else {
                    error.to_string()
                }
            })?;
        let ping = started.elapsed().as_secs_f64() * 1000.0;
        let status = response.status().as_u16();

        if accepted_status(&monitor.accepted_statuscodes, status) {
            let reason = response.status().canonical_reason().unwrap_or("");
            Ok((ping, format!("{status} - {reason}")))
        } else {
            // Node rejects through axios validateStatus with this message.
            Err(format!("Request failed with status code {status}"))
        }
    }

    /// Clients are cached by the two knobs that differ per monitor.
    fn client_for(&self, ignore_tls: bool, maxredirects: i64) -> reqwest::Client {
        let key = (ignore_tls, maxredirects);
        if let Some(client) = self.clients.lock().unwrap().get(&key) {
            return client.clone();
        }

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(
                maxredirects.max(0) as usize
            ))
            .timeout(Duration::from_secs(120));
        if ignore_tls {
            builder = builder.danger_accept_invalid_certs(true);
        }

        let client = builder.build().expect("build the http client");
        self.clients.lock().unwrap().insert(key, client.clone());
        client
    }
}

/// Does the status match any accepted range (`["200-299", "301"]`)?
/// A malformed list falls back to the Node default, 200-299.
fn accepted_status(accepted: &str, status: u16) -> bool {
    let Ok(ranges) = serde_json::from_str::<Vec<String>>(accepted) else {
        return (200..=299).contains(&status);
    };

    ranges.iter().any(|range| {
        let range = range.trim();
        if let Some((from, to)) = range.split_once('-') {
            match (from.trim().parse::<u16>(), to.trim().parse::<u16>()) {
                (Ok(from), Ok(to)) => status >= from && status <= to,
                _ => false,
            }
        } else {
            range
                .parse::<u16>()
                .map(|value| value == status)
                .unwrap_or(false)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_status_ranges_and_singles() {
        assert!(accepted_status(r#"["200-299"]"#, 200));
        assert!(accepted_status(r#"["200-299"]"#, 299));
        assert!(!accepted_status(r#"["200-299"]"#, 300));
        assert!(accepted_status(r#"["200-299", "301"]"#, 301));
        assert!(!accepted_status(r#"["200-299", "301"]"#, 302));
        // A malformed list falls back to the default range.
        assert!(accepted_status("not json", 204));
        assert!(!accepted_status("not json", 404));
    }
}
