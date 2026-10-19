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

/// Which check a loop runs.
#[derive(Clone, Copy)]
enum Check {
    Http,
    Ping,
}

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
    /// Monitors with an uptime refresh in flight, so concurrent readers
    /// cannot duplicate the same 30-day scan.
    refreshing_uptime: Mutex<std::collections::HashSet<i64>>,
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
            refreshing_uptime: Mutex::new(std::collections::HashSet::new()),
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
            "http" | "https" => {
                tokio::spawn(async move { engine.check_loop(monitor, Check::Http).await })
            }
            "ping" => tokio::spawn(async move { engine.check_loop(monitor, Check::Ping).await }),
            "group" => tokio::spawn(async move { engine.group_loop(monitor).await }),
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

    /// Uptime ratios with a short TTL, refreshed off the caller's path.
    ///
    /// The heartbeat publication path and the API both read these; waiting
    /// for the 30-day scan after every cache expiry put that query on the
    /// check loop (about 92ms per expiry for a 20s-interval monitor) and
    /// concurrent misses could duplicate it. An expired entry is served as
    /// is and refreshed in the background — one refresh per monitor at a
    /// time — while a monitor with no cached value computes inline (its
    /// first read; a fresh monitor has nothing to scan).
    pub async fn uptime_windows(self: &Arc<Self>, monitor_id: i64) -> heartbeats::UptimeWindows {
        enum Cached {
            Fresh(heartbeats::UptimeWindows),
            Stale(heartbeats::UptimeWindows),
            Missing,
        }

        let cached = {
            let cache = self.uptime.lock().unwrap();
            match cache.get(&monitor_id) {
                Some((at, windows)) if at.elapsed() < UPTIME_TTL => Cached::Fresh(*windows),
                Some((_, windows)) => Cached::Stale(*windows),
                None => Cached::Missing,
            }
        };

        match cached {
            Cached::Fresh(windows) => windows,
            Cached::Stale(windows) => {
                self.spawn_uptime_refresh(monitor_id);
                windows
            }
            Cached::Missing => self.refresh_uptime_windows(monitor_id).await,
        }
    }

    /// Recompute and cache one monitor's uptime windows.
    async fn refresh_uptime_windows(&self, monitor_id: i64) -> heartbeats::UptimeWindows {
        let windows = heartbeats::uptime_windows(&self.pool, monitor_id)
            .await
            .unwrap_or_default();
        self.uptime
            .lock()
            .unwrap()
            .insert(monitor_id, (Instant::now(), windows));
        windows
    }

    /// Refresh a stale entry in the background, at most once per monitor.
    fn spawn_uptime_refresh(self: &Arc<Self>, monitor_id: i64) {
        {
            let mut refreshing = self.refreshing_uptime.lock().unwrap();
            if !refreshing.insert(monitor_id) {
                return;
            }
        }

        let engine = Arc::clone(self);
        tokio::spawn(async move {
            engine.refresh_uptime_windows(monitor_id).await;
            engine.refreshing_uptime.lock().unwrap().remove(&monitor_id);
        });
    }

    /// The next delay for a check loop: the configured interval minus the
    /// time this iteration already spent checking and recording, measured on
    /// a monotonic clock from the check's start.
    ///
    /// Node schedules the same way (`beatInterval * 1000 - elapsed`); waiting
    /// a full interval *after* the check finished silently added the check's
    /// execution time to every cycle — a 60s HTTP monitor with a 48s failed
    /// request checked every ~108s, delaying outage detection most for
    /// exactly the slow targets. The remainder floors at 1ms so a check
    /// slower than its interval cannot spin, and checks never overlap
    /// because the loop is sequential.
    fn next_delay(started: Instant, base_seconds: i64) -> Duration {
        let base = Duration::from_secs(base_seconds.max(1) as u64);
        base.saturating_sub(started.elapsed())
            .max(Duration::from_millis(1))
    }

    /// The HTTP and ping check loops: check immediately (like the Node
    /// backend), then every interval — or every retry interval while the
    /// walk is PENDING.
    async fn check_loop(self: Arc<Self>, monitor: Monitor, check: Check) {
        loop {
            let started = Instant::now();
            let outcome = match check {
                Check::Http => self.http_check(&monitor).await,
                Check::Ping => self.ping_check(&monitor).await,
            };
            let (requested, ping, msg) = match outcome {
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
            tokio::time::sleep(Self::next_delay(started, base)).await;
        }
    }

    /// The group check loop: aggregate the direct children's latest statuses
    /// every interval (or retry interval while pending), like the Node
    /// `GroupMonitorType`.
    async fn group_loop(self: Arc<Self>, monitor: Monitor) {
        loop {
            let started = Instant::now();
            let (requested, msg) = self.group_check(&monitor).await;
            let status = match self
                .record_and_publish(&monitor, requested, None, &msg, false, None)
                .await
            {
                Ok(recorded) => recorded.beat.status,
                Err(error) => {
                    tracing::error!("engine: group heartbeat for {}: {error}", monitor.name);
                    DOWN
                }
            };

            let base = match status {
                PENDING => monitor.retry_interval.max(1),
                _ => monitor.interval.max(1),
            };
            tokio::time::sleep(Self::next_delay(started, base)).await;
        }
    }

    /// Worst-of-children status for a group.
    ///
    /// Mirrors the Node `GroupMonitorType.check`: paused children are
    /// ignored, a child without any beat counts as pending, the worst status
    /// wins, and a down child reports the names (the retry walk and the
    /// notification flow come from the shared record path). An empty group
    /// is pending rather than up.
    async fn group_check(&self, monitor: &Monitor) -> (i64, String) {
        let children: Vec<(i64, String, i64)> =
            sqlx::query_as("SELECT id, name, active FROM monitors WHERE parent = ?")
                .bind(monitor.id)
                .fetch_all(&self.pool)
                .await
                .unwrap_or_default();

        if children.is_empty() {
            return (PENDING, "Group empty".to_string());
        }

        let mut worst = UP;
        let mut down: Vec<String> = Vec::new();
        let mut pending: Vec<String> = Vec::new();

        for (id, name, active) in children {
            if active == 0 {
                continue;
            }
            let label = if name.is_empty() {
                format!("#{id}")
            } else {
                name
            };
            match heartbeats::latest(&self.pool, id).await.ok().flatten() {
                None => {
                    if worst == UP {
                        worst = PENDING;
                    }
                    pending.push(label);
                }
                Some(beat) => match beat.status {
                    DOWN => {
                        worst = DOWN;
                        down.push(label);
                    }
                    PENDING => {
                        if worst != DOWN {
                            worst = PENDING;
                        }
                        pending.push(label);
                    }
                    _ => {}
                },
            }
        }

        match worst {
            DOWN => {
                let mut message = format!("Child monitors down: {}", down.join(", "));
                if !pending.is_empty() {
                    message.push_str(&format!("; pending: {}", pending.join(", ")));
                }
                (DOWN, message)
            }
            PENDING => (
                PENDING,
                format!("Pending child monitors: {}", pending.join(", ")),
            ),
            _ => (UP, "All children up and running".to_string()),
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
            let started = Instant::now();
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
                    tokio::time::sleep(Self::next_delay(started, base)).await;
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
        let monitor = monitor.clone();
        let status = beat.status;
        let msg = beat
            .msg
            .clone()
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "N/A".to_string());

        tokio::spawn(async move {
            // The builder reads the group chain and, for push monitors, the
            // last telemetry sample — done here, off the check loop.
            let message = notify::build_heartbeat_message(&pool, &monitor, status, &msg).await;
            notify::dispatch_message(&pool, &client, monitor.id, message).await;
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

    /// One ICMP check through the system `ping` binary.
    ///
    /// Same contract as the Node wrapper: count, packet size, per-request
    /// timeout and a global deadline; the first reply time is the reading.
    /// A failure reports the raw ping output, exactly like Node.
    async fn ping_check(&self, monitor: &Monitor) -> Result<(f64, String), String> {
        let hostname = monitor
            .hostname
            .as_deref()
            .filter(|hostname| !hostname.is_empty())
            .ok_or_else(|| "No hostname configured".to_string())?;

        let count = monitor.ping_count.max(1);
        let size = monitor.packet_size.max(1);
        let deadline = if monitor.timeout > 0 {
            monitor.timeout
        } else {
            10
        };
        let per_request = monitor.ping_per_request_timeout.max(1);

        let mut args: Vec<String> = Vec::new();
        if monitor.ping_numeric != 0 {
            args.push("-n".to_string());
        }
        if cfg!(target_os = "macos") {
            // macOS: -t is the global deadline in seconds, -W is the
            // per-reply wait in milliseconds.
            args.extend([
                "-c".to_string(),
                count.to_string(),
                "-t".to_string(),
                deadline.to_string(),
                "-W".to_string(),
                (per_request * 1000).to_string(),
                "-s".to_string(),
                size.to_string(),
            ]);
        } else {
            // iputils (Linux): -W is the per-reply wait in seconds, -w the
            // global deadline.
            args.extend([
                "-W".to_string(),
                per_request.to_string(),
                "-w".to_string(),
                deadline.to_string(),
                "-c".to_string(),
                count.to_string(),
                "-s".to_string(),
                size.to_string(),
            ]);
        }
        args.push(hostname.to_string());

        let mut command = tokio::process::Command::new("ping");
        command.args(&args).kill_on_drop(true);
        let output =
            tokio::time::timeout(Duration::from_secs((deadline + 5) as u64), command.output())
                .await
                .map_err(|_| format!("ping timed out after {deadline}s"))?
                .map_err(|error| format!("ping failed to start: {error}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if let Some(ping) = parse_reply_ms(&stdout) {
            return Ok((ping, String::new()));
        }

        let message = if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            format!("ping exited with {}", output.status)
        };
        Err(message)
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

/// First reply time from `ping` output: `time=0.042 ms` or `time<1 ms`.
/// Mirrors the npm parser's "first successful reply" contract.
fn parse_reply_ms(output: &str) -> Option<f64> {
    for line in output.lines() {
        let rest = if let Some(index) = line.find("time=") {
            &line[index + 5..]
        } else if let Some(index) = line.find("time<") {
            &line[index + 5..]
        } else {
            continue;
        };
        let number: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if let Ok(value) = number.parse::<f64>() {
            return Some(value);
        }
    }
    None
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

    #[test]
    fn ping_reply_times_parse_from_real_output() {
        let linux = "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n\
                     64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.4 ms\n\
                     \n--- 1.1.1.1 ping statistics ---\n\
                     1 packets transmitted, 1 received, 0% packet loss, time 0ms\n";
        assert_eq!(parse_reply_ms(linux), Some(12.4));

        let mac = "PING 127.0.0.1 (127.0.0.1): 56 data bytes\n\
                   64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.042 ms\n";
        assert_eq!(parse_reply_ms(mac), Some(0.042));

        // Sub-millisecond replies on some builds.
        let fast = "64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time<1 ms\n";
        assert_eq!(parse_reply_ms(fast), Some(1.0));

        let dead = "PING 203.0.113.1 (203.0.113.1) 56(84) bytes of data.\n\
                    \n--- 203.0.113.1 ping statistics ---\n\
                    1 packets transmitted, 0 received, 100% packet loss, time 0ms\n";
        assert_eq!(parse_reply_ms(dead), None);
    }

    #[tokio::test]
    async fn uptime_windows_refresh_off_the_caller_path() {
        // The follow-up finding: after the TTL expired, the 30-day scan ran
        // on the heartbeat publication path (and concurrent misses could
        // duplicate it). An expired entry is now served stale and refreshed
        // in the background, one refresh per monitor at a time.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        let pool = crate::db::connect(&path).await.unwrap();
        let engine = Engine::new(pool.clone(), crate::events::Events::new());

        let (monitor_id,): (i64,) =
            sqlx::query_as("INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();

        let now = chrono::Utc::now();
        let stamp = |seconds_ago: i64| {
            (now - chrono::Duration::seconds(seconds_ago))
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        };
        // One hour UP, one hour DOWN, then UP until now: 2/3 up over the day.
        for (seconds_ago, status) in [(3 * 3600, UP), (2 * 3600, DOWN), (3600, UP)] {
            sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?)")
                .bind(monitor_id)
                .bind(stamp(seconds_ago))
                .bind(status)
                .execute(&pool)
                .await
                .unwrap();
        }

        // First read computes inline.
        let first = engine.uptime_windows(monitor_id).await;
        assert!(first.day.is_some(), "the first read computes");

        // Force the entry stale, then remove the evidence: a fresh
        // computation would report nothing, the cached read must not.
        {
            let mut cache = engine.uptime.lock().unwrap();
            let (_, windows) = *cache.get(&monitor_id).unwrap();
            cache.insert(monitor_id, (Instant::now() - UPTIME_TTL * 2, windows));
        }
        sqlx::query("DELETE FROM heartbeats WHERE monitor_id = ?")
            .bind(monitor_id)
            .execute(&pool)
            .await
            .unwrap();

        let stale = engine.uptime_windows(monitor_id).await;
        assert_eq!(stale.day, first.day, "a stale entry is served from cache");

        // The background refresh catches up; the next read sees the new state.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let refreshed = engine.uptime_windows(monitor_id).await;
        assert!(
            refreshed.day.is_none(),
            "the background refresh replaced the stale value"
        );
        let cached = engine.uptime.lock().unwrap().get(&monitor_id).cloned();
        assert!(
            cached.is_some_and(|(at, _)| at.elapsed() < UPTIME_TTL),
            "cache is fresh again"
        );
    }

    #[test]
    fn next_delay_is_measured_from_the_check_start() {
        // A 48s check inside a 60s interval leaves ~12s, not a full 60s:
        // waiting the interval after the check would make the effective
        // cadence 108s and delay outage detection most for slow targets.
        let started = Instant::now() - Duration::from_secs(48);
        let delay = Engine::next_delay(started, 60);
        assert!(
            delay <= Duration::from_secs(12) && delay > Duration::from_secs(11),
            "expected ~12s, got {delay:?}"
        );

        // A check slower than its interval must not spin or go negative.
        let slow = Instant::now() - Duration::from_secs(300);
        assert_eq!(Engine::next_delay(slow, 60), Duration::from_millis(1));

        // A normal, instant check waits the configured interval.
        let quick = Engine::next_delay(Instant::now(), 60);
        assert!(quick > Duration::from_secs(59) && quick <= Duration::from_secs(60));
    }
}
