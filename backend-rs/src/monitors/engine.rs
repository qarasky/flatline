//! Check engine: HTTP scheduling, push-timeout watching, heartbeat
//! recording, live publishing and notification dispatch.
//!
//! One supervised tokio task per active monitor, started at boot and
//! restarted when the API edits a monitor. The transition rules live in
//! `crate::heartbeats`; this module owns the timers and the side effects.
//!
//! * Restarts are generation-checked (E1): whatever order overlapping
//!   restarts and stops finish in, a monitor ends with at most one loop,
//!   and a replaced loop is always aborted, never detached.
//! * Each loop runs under a supervisor that respawns it after a panic, with
//!   backoff (E7). A watchdog respawns loops that stop making progress and
//!   stamps the liveness tick `/healthz` reads (A9).
//! * Boot spreads first checks uniformly over each monitor's interval (E5).
//! * Uptime windows are maintained incrementally from status runs (E4).
//! * Alerts go through the ordered, rate-limited [`Notifier`] (E3).
//! * Every sleep ends on the shared shutdown token (A5).
//!
//! Before [`Engine::start_all`] runs (integration tests), the engine is
//! inert: recording still works, no check loops are spawned.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::events::Events;
use crate::heartbeats::{self, Beat, DOWN, MonitorGuard, PENDING, UP, UptimeRuns};
use crate::monitors::Monitor;
use crate::notify::Notifier;
use crate::shutdown::Shutdown;

/// The push watcher's own timeout message; beats carrying it are the
/// watcher's, not the agent's (E8).
pub const PUSH_TIMEOUT_MSG: &str = "No heartbeat in the time window";

/// How often the watchdog checks the loops and stamps the liveness tick.
const WATCHDOG_PERIOD: Duration = Duration::from_secs(5);
/// `/healthz` fails when the watchdog tick is older than this.
pub const WATCHDOG_STALE: Duration = Duration::from_secs(30);
/// First respawn delay after a panic; doubles up to the cap.
const RESPAWN_BACKOFF_MIN: Duration = Duration::from_secs(1);
const RESPAWN_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A loop that ran this long before panicking starts the backoff over.
const HEALTHY_RUN: Duration = Duration::from_secs(600);
/// Retry delay after a database error, instead of a full interval (E9).
const ERROR_RETRY: Duration = Duration::from_secs(5);
/// Retry delay when a monitor row could not be loaded on (re)start.
const LOAD_RETRY: Duration = Duration::from_secs(5);
/// On shutdown, loops get this long to reach a sleep before being aborted.
const LOOP_GRACE: Duration = Duration::from_secs(2);

/// Full reload of a monitor's status runs, to absorb writes that bypassed
/// the engine (imports, retention). One reload per maintainer tick at most.
const UPTIME_RELOAD: Duration = Duration::from_secs(6 * 3600);
/// Monitors flapping past [`MAX_RUNS`] fall back to a cached SQL scan,
/// refreshed off the hot path this often.
const UPTIME_SCAN_TTL: Duration = Duration::from_secs(300);
const UPTIME_MAINTAIN_PERIOD: Duration = Duration::from_secs(5);
/// Bound on the in-memory run list per monitor (16 bytes per run).
const MAX_RUNS: usize = 100_000;

/// Which loop a monitor runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Http,
    Ping,
    Group,
    Push,
}

impl Kind {
    fn of(monitor: &Monitor) -> Option<Self> {
        match monitor.kind.as_str() {
            "http" | "https" => Some(Self::Http),
            "ping" => Some(Self::Ping),
            "group" => Some(Self::Group),
            "push" => Some(Self::Push),
            _ => None,
        }
    }
}

/// A running monitor task.
struct Slot {
    /// Read by the E1 test; the wanted map is the source of truth.
    #[cfg_attr(not(test), allow(dead_code))]
    generation: u64,
    handle: JoinHandle<()>,
    /// Engine-clock millis of the loop's last iteration.
    progress: Arc<AtomicU64>,
    /// Longest healthy gap between iterations, in millis.
    budget_ms: u64,
}

/// Task bookkeeping, under one lock so restart and stop are atomic (E1).
#[derive(Default)]
struct Tasks {
    counter: u64,
    /// The generation that may own each monitor's slot. A restart that
    /// finishes loading after a newer restart (or a stop) sees a mismatch
    /// and gives up instead of spawning a second loop.
    wanted: HashMap<i64, u64>,
    running: HashMap<i64, Slot>,
}

enum UptimeEntry {
    /// Maintained beat by beat.
    Runs { runs: UptimeRuns, loaded: Instant },
    /// Overflow fallback: a cached 30-day scan.
    Scanned {
        windows: heartbeats::UptimeWindows,
        at: Instant,
    },
}

/// What `/healthz` needs from the engine.
#[derive(Debug, Clone, Copy)]
pub struct Liveness {
    pub running: bool,
    /// Age of the watchdog's last tick; `None` before the first one.
    pub tick_age: Option<Duration>,
    pub loops: usize,
    /// Loops past their progress budget (the watchdog respawns them).
    pub stalled: usize,
}

impl Liveness {
    /// `Err(reason)` when the engine should be reported unhealthy.
    pub fn check(&self) -> Result<(), &'static str> {
        if !self.running {
            return Err("engine not running");
        }
        match self.tick_age {
            None => Err("engine watchdog has not ticked"),
            Some(age) if age > WATCHDOG_STALE => Err("engine watchdog stalled"),
            Some(_) => Ok(()),
        }
    }
}

/// Aborts the task when dropped, so cancelling a supervisor cancels the
/// loop it supervises instead of detaching it.
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Run `make(attempt)` as a task and respawn it when it panics, with
/// exponential backoff, until it returns, the outer task is aborted, or
/// shutdown is triggered (E7).
fn spawn_supervised<F, Fut>(label: String, shutdown: Shutdown, make: F) -> JoinHandle<()>
where
    F: Fn(u32) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let mut backoff = RESPAWN_BACKOFF_MIN;
        let mut attempt = 0u32;
        loop {
            let started = Instant::now();
            let mut inner = AbortOnDrop(tokio::spawn(make(attempt)));
            match (&mut inner.0).await {
                Ok(()) => return,
                Err(error) if error.is_cancelled() => return,
                Err(error) => {
                    if started.elapsed() >= HEALTHY_RUN {
                        backoff = RESPAWN_BACKOFF_MIN;
                    }
                    tracing::error!(
                        "engine: {label} panicked: {error}; respawning in {}s",
                        backoff.as_secs()
                    );
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = shutdown.wait() => return,
            }
            backoff = (backoff * 2).min(RESPAWN_BACKOFF_MAX);
            attempt = attempt.saturating_add(1);
        }
    })
}

/// Random first-check delay in `[0, interval)` (E5).
///
/// Every loop used to start at boot and check at the same instant, and the
/// drift-free scheduler keeps loops phase-locked forever, so the whole
/// fleet hit the pool (and the network) in one burst per interval. A
/// uniform offset per monitor spreads them, and drift-free scheduling then
/// keeps them spread.
fn initial_delay(interval_seconds: i64) -> Duration {
    let interval_ms = interval_seconds.max(1) as u64 * 1000;
    Duration::from_millis(rand::random_range(0..interval_ms))
}

/// Age of the newest agent beat, robust against wall-clock steps (E6).
///
/// The wall-clock age of a beat stamped in the "future" (the clock stepped
/// backwards) is negative; it is clamped at 0, and once a beat has been
/// seen its age also grows on the monotonic clock, so a backwards step can
/// no longer keep a silent agent looking fresh.
#[derive(Default)]
struct BeatAge {
    seen: Option<(i64, Instant, i64)>,
}

impl BeatAge {
    /// Age in millis of beat `id` whose wall-clock age is `wall_ms`.
    fn age_ms(&mut self, id: i64, wall_ms: Option<i64>, now: Instant) -> i64 {
        let Some(wall_ms) = wall_ms else {
            // Unparseable time: treat as expired.
            return i64::MAX;
        };
        let wall_ms = wall_ms.max(0);
        match self.seen {
            Some((seen_id, first_seen, base)) if seen_id == id => {
                let monotonic = base + now.saturating_duration_since(first_seen).as_millis() as i64;
                wall_ms.max(monotonic)
            }
            _ => {
                self.seen = Some((id, now, wall_ms));
                wall_ms
            }
        }
    }
}

/// How long the push watcher waits after a fresh beat of age `age_ms`:
/// until just past the next expected beat, never more than `interval + 1s`.
fn push_wait_ms(interval_ms: i64, age_ms: i64) -> i64 {
    (interval_ms - age_ms.max(0)).clamp(0, interval_ms) + 1000
}

pub struct Engine {
    pool: SqlitePool,
    events: Arc<Events>,
    /// Check clients differ per monitor (TLS tolerance, redirect cap), so
    /// they are cached by those two knobs instead of rebuilt per check.
    clients: Mutex<HashMap<(bool, i64), reqwest::Client>>,
    notifier: Arc<Notifier>,
    tasks: Mutex<Tasks>,
    running: AtomicBool,
    /// Wait a full interval before the first push-timeout check. Node does
    /// this so a backend restart cannot page while a live agent's next
    /// push is still in flight. Tests skip it to stay fast.
    boot_delay_push: bool,
    /// Spread first checks over the interval at boot (E5). Tests skip it.
    boot_jitter: bool,
    uptime: Mutex<HashMap<i64, UptimeEntry>>,
    /// Reference point for the engine's monotonic millis.
    epoch: Instant,
    /// Engine-clock millis of the last watchdog tick, +1 (0 = never).
    last_tick: AtomicU64,
    /// Watchdog and uptime maintainer.
    background: Mutex<Vec<JoinHandle<()>>>,
    shutdown: Shutdown,
}

impl Engine {
    pub fn new(pool: SqlitePool, events: Arc<Events>) -> Arc<Self> {
        Self::build(pool, events, true)
    }

    /// Test seam: push watchers skip the initial interval-long wait and
    /// boot skips the first-check jitter, so loop behavior can be exercised
    /// quickly. Production uses [`Self::new`].
    pub fn for_tests(pool: SqlitePool, events: Arc<Events>) -> Arc<Self> {
        Self::build(pool, events, false)
    }

    fn build(pool: SqlitePool, events: Arc<Events>, production: bool) -> Arc<Self> {
        let notify_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Arc::new(Self {
            notifier: Notifier::new(pool.clone(), notify_client),
            pool,
            events,
            clients: Mutex::new(HashMap::new()),
            tasks: Mutex::new(Tasks::default()),
            running: AtomicBool::new(false),
            boot_delay_push: production,
            boot_jitter: production,
            uptime: Mutex::new(HashMap::new()),
            epoch: Instant::now(),
            last_tick: AtomicU64::new(0),
            background: Mutex::new(Vec::new()),
            shutdown: Shutdown::new(),
        })
    }

    /// The shared shutdown token (A5): SSE streams and the HTTP server
    /// wait on it; triggering it stops every engine sleep.
    pub fn shutdown_token(&self) -> Shutdown {
        self.shutdown.clone()
    }

    /// The alert queue; the server drains it on shutdown.
    pub fn notifier(&self) -> &Arc<Notifier> {
        &self.notifier
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// Boot: the watchdog, the uptime maintainer, one task per active
    /// monitor (first checks jittered over the interval).
    pub async fn start_all(self: &Arc<Self>) {
        if self.shutdown.is_triggered() || self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.last_tick.store(self.now_ms() + 1, Ordering::SeqCst);

        {
            let mut background = self.background.lock().unwrap();
            let engine = Arc::clone(self);
            background.push(spawn_supervised(
                "watchdog".to_string(),
                self.shutdown.clone(),
                move |_| Arc::clone(&engine).watchdog(),
            ));
            let engine = Arc::clone(self);
            background.push(spawn_supervised(
                "uptime maintainer".to_string(),
                self.shutdown.clone(),
                move |attempt| Arc::clone(&engine).maintain_uptime(attempt == 0),
            ));
        }

        let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM monitors WHERE active = 1")
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default();
        for id in ids {
            self.spawn_monitor(id, self.boot_jitter).await;
        }
    }

    /// (Re)start the task for one monitor; a no-op for inactive or unknown
    /// monitors and while the engine is inert.
    pub async fn restart(self: &Arc<Self>, id: i64) {
        self.spawn_monitor(id, false).await;
    }

    /// Stop the task for a monitor (deleted, paused, or restarted). Also
    /// invalidates any restart still loading, so it cannot spawn after.
    pub fn stop(&self, id: i64) {
        let mut tasks = self.tasks.lock().unwrap();
        tasks.wanted.remove(&id);
        if let Some(slot) = tasks.running.remove(&id) {
            slot.handle.abort();
        }
    }

    /// The restart protocol (E1).
    ///
    /// 1. Under the task lock: take a new generation, mark it wanted, abort
    ///    the current loop.
    /// 2. Load the monitor (await — other restarts may run meanwhile).
    /// 3. Under the task lock again: spawn only if this generation is still
    ///    the wanted one, and abort whatever handle the insert replaces.
    fn spawn_monitor<'a>(
        self: &'a Arc<Self>,
        id: i64,
        jitter: bool,
    ) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            if !self.running.load(Ordering::SeqCst) {
                return;
            }
            let generation = {
                let mut tasks = self.tasks.lock().unwrap();
                tasks.counter += 1;
                let generation = tasks.counter;
                tasks.wanted.insert(id, generation);
                if let Some(slot) = tasks.running.remove(&id) {
                    slot.handle.abort();
                }
                generation
            };

            let loaded = sqlx::query_as::<_, Monitor>("SELECT * FROM monitors WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await;
            let monitor = match loaded {
                Ok(Some(monitor)) if monitor.active != 0 && Kind::of(&monitor).is_some() => monitor,
                Ok(_) => {
                    self.release(id, generation);
                    return;
                }
                Err(error) => {
                    // Previously the loop just stayed stopped; retry unless
                    // something newer took over meanwhile.
                    tracing::error!(
                        "engine: load monitor {id}: {error}; retrying in {}s",
                        LOAD_RETRY.as_secs()
                    );
                    let engine = Arc::clone(self);
                    tokio::spawn(async move {
                        if !engine.pause(LOAD_RETRY).await {
                            return;
                        }
                        let current =
                            engine.tasks.lock().unwrap().wanted.get(&id) == Some(&generation);
                        if current {
                            engine.spawn_monitor(id, false).await;
                        }
                    });
                    return;
                }
            };
            let kind = Kind::of(&monitor).expect("checked above");

            let mut tasks = self.tasks.lock().unwrap();
            if !self.running.load(Ordering::SeqCst) || tasks.wanted.get(&id) != Some(&generation) {
                return;
            }
            let longest = monitor.interval.max(monitor.retry_interval).max(1) as u64;
            let budget_ms = (2 * longest + monitor.timeout.max(0) as u64 + 300) * 1000;
            let progress = Arc::new(AtomicU64::new(self.now_ms()));
            let handle = self.spawn_loop(monitor, kind, jitter, Arc::clone(&progress));
            let slot = Slot {
                generation,
                handle,
                progress,
                budget_ms,
            };
            if let Some(old) = tasks.running.insert(id, slot) {
                old.handle.abort();
            }
        })
    }

    /// Forget a wanted generation that will not spawn (row gone, paused).
    fn release(&self, id: i64, generation: u64) {
        let mut tasks = self.tasks.lock().unwrap();
        if tasks.wanted.get(&id) == Some(&generation) {
            tasks.wanted.remove(&id);
        }
    }

    /// Spawn one monitor's supervised loop.
    fn spawn_loop(
        self: &Arc<Self>,
        monitor: Monitor,
        kind: Kind,
        jitter: bool,
        progress: Arc<AtomicU64>,
    ) -> JoinHandle<()> {
        let initial = if jitter && kind != Kind::Push {
            initial_delay(monitor.interval)
        } else {
            Duration::ZERO
        };
        let label = format!("check loop for monitor {} ({})", monitor.id, monitor.name);
        let engine = Arc::clone(self);
        spawn_supervised(label, self.shutdown.clone(), move |attempt| {
            let engine = Arc::clone(&engine);
            let monitor = monitor.clone();
            let progress = Arc::clone(&progress);
            // A respawn after a panic checks right away.
            let initial = if attempt == 0 {
                initial
            } else {
                Duration::ZERO
            };
            async move {
                match kind {
                    Kind::Http | Kind::Ping => {
                        engine.check_loop(monitor, kind, initial, progress).await
                    }
                    Kind::Group => engine.group_loop(monitor, initial, progress).await,
                    Kind::Push => engine.push_loop(monitor, progress).await,
                }
            }
        })
    }

    /// Sleep unless shutdown comes first; `false` means "stop now".
    async fn pause(&self, duration: Duration) -> bool {
        if self.shutdown.is_triggered() {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(duration) => true,
            _ = self.shutdown.wait() => false,
        }
    }

    /// Stamp the liveness tick, respawn dead or stalled loops (E7).
    async fn watchdog(self: Arc<Self>) {
        loop {
            self.last_tick.store(self.now_ms() + 1, Ordering::SeqCst);

            let now = self.now_ms();
            let (dead, stalled): (Vec<i64>, Vec<(i64, u64)>) = {
                let tasks = self.tasks.lock().unwrap();
                let mut dead = Vec::new();
                let mut stalled = Vec::new();
                for (id, slot) in &tasks.running {
                    if slot.handle.is_finished() {
                        dead.push(*id);
                    } else {
                        let idle = now.saturating_sub(slot.progress.load(Ordering::SeqCst));
                        if idle > slot.budget_ms {
                            stalled.push((*id, idle));
                        }
                    }
                }
                (dead, stalled)
            };
            for id in dead {
                tracing::error!("engine: task for monitor {id} exited unexpectedly; respawning");
                self.spawn_monitor(id, false).await;
            }
            for (id, idle) in stalled {
                tracing::error!(
                    "engine: check loop for monitor {id} made no progress for {}s; respawning",
                    idle / 1000
                );
                self.spawn_monitor(id, false).await;
            }

            if !self.pause(WATCHDOG_PERIOD).await {
                return;
            }
        }
    }

    /// Liveness for `/healthz`.
    pub fn liveness(&self) -> Liveness {
        let now = self.now_ms();
        let tick = self.last_tick.load(Ordering::SeqCst);
        let tick_age = (tick > 0).then(|| Duration::from_millis(now.saturating_sub(tick - 1)));
        let tasks = self.tasks.lock().unwrap();
        let stalled = tasks
            .running
            .values()
            .filter(|slot| {
                now.saturating_sub(slot.progress.load(Ordering::SeqCst)) > slot.budget_ms
            })
            .count();
        Liveness {
            running: self.running.load(Ordering::SeqCst) && !self.shutdown.is_triggered(),
            tick_age,
            loops: tasks.running.len(),
            stalled,
        }
    }

    /// Stop every loop (A5): trigger the token, give loops [`LOOP_GRACE`]
    /// to reach a sleep, abort the rest. Restarts become no-ops. Alerts
    /// already queued are left for [`Notifier::shutdown`].
    pub async fn stop_checks(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.shutdown.trigger();
        let mut handles: Vec<JoinHandle<()>> = {
            let mut tasks = self.tasks.lock().unwrap();
            tasks.wanted.clear();
            tasks.running.drain().map(|(_, slot)| slot.handle).collect()
        };
        handles.append(&mut self.background.lock().unwrap());

        let grace = tokio::time::Instant::now() + LOOP_GRACE;
        let mut aborted = 0;
        for mut handle in handles {
            if tokio::time::timeout_at(grace, &mut handle).await.is_err() {
                handle.abort();
                aborted += 1;
            }
        }
        if aborted > 0 {
            tracing::warn!("engine: aborted {aborted} loops still busy at shutdown");
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

    /// Uptime ratios for one monitor, from memory (E4).
    ///
    /// The first read of a monitor loads its status runs (one 30-day scan);
    /// after that every recorded beat is folded in as it is written, and
    /// the windows are computed from the run list — a handful of entries
    /// for a healthy monitor — without touching the database. The old
    /// 30 s TTL meant every monitor rescanned 30 days every 30 s (about
    /// 92 ms each), all of them at boot at once.
    pub async fn uptime_windows(self: &Arc<Self>, monitor_id: i64) -> heartbeats::UptimeWindows {
        if let Some(windows) = self.cached_windows(monitor_id) {
            return windows;
        }
        let guard = heartbeats::lock_monitor(monitor_id).await;
        self.uptime_windows_locked(&guard).await
    }

    fn cached_windows(&self, monitor_id: i64) -> Option<heartbeats::UptimeWindows> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cache = self.uptime.lock().unwrap();
        match cache.get(&monitor_id)? {
            UptimeEntry::Runs { runs, .. } => Some(runs.windows(now_ms)),
            UptimeEntry::Scanned { windows, .. } => Some(*windows),
        }
    }

    async fn uptime_windows_locked(&self, guard: &MonitorGuard) -> heartbeats::UptimeWindows {
        match self.cached_windows(guard.monitor_id()) {
            Some(windows) => windows,
            None => self.load_uptime_locked(guard).await,
        }
    }

    /// (Re)load one monitor's uptime state; the caller holds its heartbeat
    /// lock, so no beat can land between the scan and the install.
    async fn load_uptime_locked(&self, guard: &MonitorGuard) -> heartbeats::UptimeWindows {
        let monitor_id = guard.monitor_id();
        let now_ms = chrono::Utc::now().timestamp_millis();
        match heartbeats::load_runs(&self.pool, monitor_id).await {
            Ok(runs) if runs.len() <= MAX_RUNS => {
                let windows = runs.windows(now_ms);
                self.uptime.lock().unwrap().insert(
                    monitor_id,
                    UptimeEntry::Runs {
                        runs,
                        loaded: Instant::now(),
                    },
                );
                windows
            }
            Ok(_) => {
                let windows = heartbeats::uptime_windows(&self.pool, monitor_id)
                    .await
                    .unwrap_or_default();
                self.uptime.lock().unwrap().insert(
                    monitor_id,
                    UptimeEntry::Scanned {
                        windows,
                        at: Instant::now(),
                    },
                );
                windows
            }
            Err(error) => {
                tracing::warn!("engine: load uptime for monitor {monitor_id}: {error}");
                heartbeats::UptimeWindows::default()
            }
        }
    }

    /// Fold a freshly recorded beat into the run list. A gap in the chain
    /// (someone wrote around the engine) drops the entry for a reload.
    fn note_beat_locked(&self, guard: &MonitorGuard, recorded: &heartbeats::Recorded) {
        let monitor_id = guard.monitor_id();
        let mut cache = self.uptime.lock().unwrap();
        let Some(UptimeEntry::Runs { runs, .. }) = cache.get_mut(&monitor_id) else {
            return;
        };
        let time_ms = heartbeats::time_ms(&recorded.beat.time);
        match time_ms {
            Some(time_ms) if runs.last_id == recorded.previous_id => {
                runs.push(recorded.beat.id, time_ms, recorded.beat.status);
                runs.trim(chrono::Utc::now().timestamp_millis());
                if runs.len() > MAX_RUNS {
                    cache.remove(&monitor_id);
                }
            }
            _ => {
                cache.remove(&monitor_id);
            }
        }
    }

    /// Off-path uptime upkeep: warm every monitor serially at boot (so the
    /// first reads do not all scan at once), then reload one due entry per
    /// tick — the stalest run list past [`UPTIME_RELOAD`], or a fallback
    /// scan past [`UPTIME_SCAN_TTL`] — and forget deleted monitors.
    async fn maintain_uptime(self: Arc<Self>, warm: bool) {
        if warm {
            let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM monitors WHERE active = 1")
                .fetch_all(&self.pool)
                .await
                .unwrap_or_default();
            for id in ids {
                if self.shutdown.is_triggered() {
                    return;
                }
                if self.cached_windows(id).is_none() {
                    let guard = heartbeats::lock_monitor(id).await;
                    if self.cached_windows(id).is_none() {
                        self.load_uptime_locked(&guard).await;
                    }
                }
            }
        }

        let mut ticks: u64 = 0;
        loop {
            if !self.pause(UPTIME_MAINTAIN_PERIOD).await {
                return;
            }
            ticks += 1;

            if ticks.is_multiple_of(720) {
                // Hourly: drop entries of monitors that no longer exist.
                if let Ok(ids) = sqlx::query_scalar::<_, i64>("SELECT id FROM monitors")
                    .fetch_all(&self.pool)
                    .await
                {
                    let ids: std::collections::HashSet<i64> = ids.into_iter().collect();
                    self.uptime.lock().unwrap().retain(|id, _| ids.contains(id));
                }
            }

            let due = {
                let cache = self.uptime.lock().unwrap();
                cache
                    .iter()
                    .filter_map(|(id, entry)| {
                        let (age, limit) = match entry {
                            UptimeEntry::Runs { loaded, .. } => (loaded.elapsed(), UPTIME_RELOAD),
                            UptimeEntry::Scanned { at, .. } => (at.elapsed(), UPTIME_SCAN_TTL),
                        };
                        (age >= limit).then_some((*id, age.saturating_sub(limit)))
                    })
                    .max_by_key(|(_, overdue)| *overdue)
                    .map(|(id, _)| id)
            };
            if let Some(id) = due {
                let guard = heartbeats::lock_monitor(id).await;
                self.load_uptime_locked(&guard).await;
            }
        }
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

    /// The delay after recording: interval, retry interval while PENDING,
    /// or a short retry after a database error (E9: a failed record used to
    /// wait a full interval, so one lock timeout cost a whole cycle of
    /// detection).
    fn delay_after(
        monitor: &Monitor,
        started: Instant,
        result: &sqlx::Result<heartbeats::Recorded>,
    ) -> Duration {
        match result {
            Ok(recorded) if recorded.beat.status == PENDING => {
                Self::next_delay(started, monitor.retry_interval.max(1))
            }
            Ok(_) => Self::next_delay(started, monitor.interval.max(1)),
            Err(_) => ERROR_RETRY.min(Duration::from_secs(monitor.interval.max(1) as u64)),
        }
    }

    /// The HTTP and ping check loops: check (after the boot jitter), then
    /// every interval — or every retry interval while the walk is PENDING.
    async fn check_loop(
        self: Arc<Self>,
        monitor: Monitor,
        kind: Kind,
        initial: Duration,
        progress: Arc<AtomicU64>,
    ) {
        if !initial.is_zero() && !self.pause(initial).await {
            return;
        }
        loop {
            progress.store(self.now_ms(), Ordering::SeqCst);
            let started = Instant::now();
            let outcome = match kind {
                Kind::Ping => self.ping_check(&monitor).await,
                _ => self.http_check(&monitor).await,
            };
            let (requested, ping, msg) = match outcome {
                Ok((ping, msg)) => (UP, Some(ping), msg),
                Err(message) => (DOWN, None, message),
            };

            let result = self
                .record_and_publish(&monitor, requested, ping, &msg, false, None)
                .await;
            if let Err(error) = &result {
                tracing::error!("engine: heartbeat for {}: {error}", monitor.name);
            }
            progress.store(self.now_ms(), Ordering::SeqCst);
            if !self
                .pause(Self::delay_after(&monitor, started, &result))
                .await
            {
                return;
            }
        }
    }

    /// The group check loop: aggregate the direct children's latest statuses
    /// every interval (or retry interval while pending), like the Node
    /// `GroupMonitorType`.
    async fn group_loop(
        self: Arc<Self>,
        monitor: Monitor,
        initial: Duration,
        progress: Arc<AtomicU64>,
    ) {
        if !initial.is_zero() && !self.pause(initial).await {
            return;
        }
        loop {
            progress.store(self.now_ms(), Ordering::SeqCst);
            let started = Instant::now();
            let (requested, msg) = self.group_check(&monitor).await;
            let result = self
                .record_and_publish(&monitor, requested, None, &msg, false, None)
                .await;
            if let Err(error) = &result {
                tracing::error!("engine: group heartbeat for {}: {error}", monitor.name);
            }
            progress.store(self.now_ms(), Ordering::SeqCst);
            if !self
                .pause(Self::delay_after(&monitor, started, &result))
                .await
            {
                return;
            }
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

    /// The push watcher: fail when no agent heartbeat lands inside
    /// `interval + 1s` (Node's buffer for clock differences), otherwise
    /// reschedule just past the next expected beat. Pushes are recorded by
    /// the push endpoint, never here.
    ///
    /// E8: freshness is the age of the newest *agent* beat, whatever its
    /// status. An agent actively pushing `down` is alive; treating its DOWN
    /// beats as silence added "No heartbeat" rows and doubled `down_count`.
    /// The watcher's own timeout beats do not count as agent beats, so a
    /// silent agent still walks PENDING → DOWN at the retry cadence.
    ///
    /// E6: ages are clamped and tracked on the monotonic clock (see
    /// [`BeatAge`]), and a fresh beat never schedules more than
    /// `interval + 1s` ahead.
    async fn push_loop(self: Arc<Self>, monitor: Monitor, progress: Arc<AtomicU64>) {
        let interval_ms = monitor.interval.max(1) * 1000;

        if self.boot_delay_push {
            // Node delays the first push check by a full interval.
            progress.store(self.now_ms(), Ordering::SeqCst);
            if !self
                .pause(Duration::from_secs(monitor.interval.max(1) as u64))
                .await
            {
                return;
            }
        }

        let mut own_beat: Option<i64> = None;
        let mut age = BeatAge::default();
        loop {
            progress.store(self.now_ms(), Ordering::SeqCst);
            let started = Instant::now();
            let latest = match heartbeats::latest(&self.pool, monitor.id).await {
                Ok(latest) => latest,
                Err(error) => {
                    tracing::error!("engine: push watcher for {}: {error}", monitor.name);
                    if !self.pause(ERROR_RETRY).await {
                        return;
                    }
                    continue;
                }
            };

            let agent_beat = latest.as_ref().filter(|beat| {
                Some(beat.id) != own_beat && beat.msg.as_deref() != Some(PUSH_TIMEOUT_MSG)
            });
            if let Some(beat) = agent_beat {
                let beat_age = age.age_ms(
                    beat.id,
                    heartbeats::millis_since(&beat.time),
                    Instant::now(),
                );
                if beat_age <= interval_ms + 1000 {
                    let wait = push_wait_ms(interval_ms, beat_age);
                    if !self.pause(Duration::from_millis(wait as u64)).await {
                        return;
                    }
                    continue;
                }
            }

            let duration = latest
                .as_ref()
                .and_then(|beat| heartbeats::millis_since(&beat.time))
                .map(|ms| (ms.max(0) + 500) / 1000)
                .unwrap_or(monitor.interval.max(1));

            let result = self
                .record_and_publish(
                    &monitor,
                    DOWN,
                    None,
                    PUSH_TIMEOUT_MSG,
                    false,
                    Some(duration),
                )
                .await;
            match &result {
                Ok(recorded) => own_beat = Some(recorded.beat.id),
                Err(error) => {
                    tracing::error!("engine: push timeout for {}: {error}", monitor.name);
                }
            }
            progress.store(self.now_ms(), Ordering::SeqCst);
            if !self
                .pause(Self::delay_after(&monitor, started, &result))
                .await
            {
                return;
            }
        }
    }

    /// Record, publish, notify — the shared tail of every check path.
    ///
    /// Everything happens under the monitor's heartbeat lock (E2): the
    /// transition is decided once, the uptime cache sees beats in order,
    /// and alerts are enqueued in transition order (E3).
    async fn record_and_publish(
        self: &Arc<Self>,
        monitor: &Monitor,
        requested: i64,
        ping: Option<f64>,
        msg: &str,
        explicit_down: bool,
        duration_override: Option<i64>,
    ) -> sqlx::Result<heartbeats::Recorded> {
        let guard = heartbeats::lock_monitor(monitor.id).await;
        let recorded = heartbeats::record_locked(
            &guard,
            &self.pool,
            monitor,
            requested,
            ping,
            msg,
            explicit_down,
            duration_override,
        )
        .await?;

        self.note_beat_locked(&guard, &recorded);
        let uptime = self.uptime_windows_locked(&guard).await;
        self.publish_heartbeat(monitor, &recorded.beat, uptime);

        // A status change can end or shrink a mute; decided before the alert
        // so a new outage that ends a mute is sent as usual.
        if recorded.is_first || recorded.previous_status != Some(recorded.beat.status) {
            match crate::mutes::on_status(&self.pool, monitor.id, recorded.beat.status).await {
                Ok(true) => self.events.invalidate(),
                Ok(false) => {}
                Err(error) => {
                    tracing::error!("engine: mute update for {}: {error}", monitor.name)
                }
            }
        }

        if recorded.notify {
            let message = recorded
                .beat
                .msg
                .as_deref()
                .filter(|message| !message.is_empty())
                .unwrap_or("N/A");
            self.notifier
                .enqueue_heartbeat(monitor, recorded.beat.status, message);
        }

        Ok(recorded)
    }

    /// SSE `heartbeat` event, shaped like the Node live update.
    fn publish_heartbeat(&self, monitor: &Monitor, beat: &Beat, uptime: heartbeats::UptimeWindows) {
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

    async fn scratch_engine() -> (SqlitePool, Arc<Engine>) {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::connect(&dir.keep()).await.unwrap();
        let engine = Engine::for_tests(pool.clone(), crate::events::Events::new());
        (pool, engine)
    }

    async fn closed_port_url() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}/")
    }

    async fn beats(pool: &SqlitePool, id: i64) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_restarts_leave_exactly_one_loop() {
        // E1: two overlapping restarts both spawned, and the replaced
        // JoinHandle was dropped (detached) — an unstoppable second loop.
        let (pool, engine) = scratch_engine().await;
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO monitors (name, type, url, interval, timeout) VALUES ('dead', 'http', ?, 1, 1) RETURNING id",
        )
        .bind(closed_port_url().await)
        .fetch_one(&pool)
        .await
        .unwrap();
        engine.start_all().await;

        let mut restarts = Vec::new();
        for _ in 0..24 {
            let engine = Arc::clone(&engine);
            restarts.push(tokio::spawn(async move { engine.restart(id).await }));
        }
        for restart in restarts {
            restart.await.unwrap();
        }
        {
            let tasks = engine.tasks.lock().unwrap();
            assert_eq!(tasks.running.len(), 1, "one slot");
            let slot = &tasks.running[&id];
            assert_eq!(
                tasks.wanted.get(&id),
                Some(&slot.generation),
                "the newest generation won"
            );
        }

        // One loop at a 1 s interval writes about one beat per second; 25
        // orphans would write ~25.
        let before = beats(&pool, id).await;
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let written = beats(&pool, id).await - before;
        assert!(written <= 4, "one loop, not many: {written} beats in 2.5 s");

        // Stopping really stops: no orphan keeps writing.
        engine.stop(id);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let stopped = beats(&pool, id).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(beats(&pool, id).await, stopped, "no loop survives stop");
        engine.stop_checks().await;
    }

    #[test]
    fn initial_delay_is_uniform_within_the_interval() {
        // E5: first checks spread over [0, interval).
        let samples: Vec<Duration> = (0..2000).map(|_| initial_delay(20)).collect();
        assert!(samples.iter().all(|delay| *delay < Duration::from_secs(20)));
        let min = samples.iter().min().unwrap();
        let max = samples.iter().max().unwrap();
        assert!(
            *min < Duration::from_secs(2),
            "spread reaches the start: {min:?}"
        );
        assert!(
            *max > Duration::from_secs(18),
            "spread reaches the end: {max:?}"
        );
        // Degenerate intervals stay in bounds.
        assert!(initial_delay(0) < Duration::from_secs(1));
        assert!(initial_delay(1) < Duration::from_secs(1));
    }

    #[test]
    fn push_age_is_clamped_and_monotonic_across_clock_steps() {
        // E6: after a backwards clock step the beat looks an hour in the
        // future. Its age clamps at 0 (no negative wait arithmetic), the
        // wait is capped at interval + 1 s, and the monotonic clock still
        // ages it so a silent agent times out.
        let interval_ms = 20_000;
        let start = Instant::now();
        let mut age = BeatAge::default();

        let first = age.age_ms(7, Some(-3_600_000), start);
        assert_eq!(first, 0);
        assert_eq!(push_wait_ms(interval_ms, first), interval_ms + 1000);
        assert_eq!(push_wait_ms(interval_ms, -5_000), interval_ms + 1000);
        assert_eq!(push_wait_ms(interval_ms, 5_000), 16_000);
        assert_eq!(push_wait_ms(interval_ms, 50_000), 1000);

        // 25 s later the wall clock still says "future", the monotonic age
        // says 25 s: expired.
        let later = age.age_ms(7, Some(-3_575_000), start + Duration::from_secs(25));
        assert!(later > interval_ms + 1000, "monotonic age wins: {later}");

        // A new beat starts over; an unparseable time is expired.
        assert_eq!(
            age.age_ms(8, Some(500), start + Duration::from_secs(25)),
            500
        );
        assert!(age.age_ms(9, None, start) > interval_ms + 1000);
    }

    #[tokio::test]
    async fn supervisor_respawns_a_panicking_loop_and_abort_reaches_it() {
        // E7: a panicking loop used to freeze its monitor silently.
        use std::sync::atomic::AtomicUsize;
        let attempts = Arc::new(AtomicUsize::new(0));
        let ticks = Arc::new(AtomicUsize::new(0));
        let shutdown = Shutdown::new();
        let handle = {
            let attempts = Arc::clone(&attempts);
            let ticks = Arc::clone(&ticks);
            spawn_supervised("test loop".into(), shutdown.clone(), move |attempt| {
                let attempts = Arc::clone(&attempts);
                let ticks = Arc::clone(&ticks);
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        panic!("boom");
                    }
                    loop {
                        ticks.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            })
        };

        tokio::time::sleep(RESPAWN_BACKOFF_MIN + Duration::from_millis(400)).await;
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "respawned once after the panic"
        );
        assert!(ticks.load(Ordering::SeqCst) > 0, "the respawned loop runs");
        assert!(!handle.is_finished());

        // Aborting the supervisor aborts the loop too (no detached task).
        handle.abort();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let frozen = ticks.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            frozen,
            "the inner loop is gone"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn push_watcher_ignores_an_agent_actively_pushing_down() {
        // E8: any non-UP latest beat used to count as a timeout.
        let (pool, engine) = scratch_engine().await;
        let monitor = sqlx::query_as::<_, Monitor>(
            "INSERT INTO monitors (name, type, interval, retry_interval) VALUES ('agent', 'push', 1, 1) RETURNING *",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        engine
            .record_heartbeat(&monitor, DOWN, None, "disk full", true)
            .await
            .unwrap();
        engine.start_all().await;

        let timeouts = || async {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ? AND msg = ?",
            )
            .bind(monitor.id)
            .bind(PUSH_TIMEOUT_MSG)
            .fetch_one(&pool)
            .await
            .unwrap()
        };

        // The agent keeps pushing `down` every 400 ms for 3 s.
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            engine
                .record_heartbeat(&monitor, DOWN, None, "disk full", true)
                .await
                .unwrap();
        }
        assert_eq!(
            timeouts().await,
            0,
            "a live agent pushing down is not silent"
        );

        // Silence: the watcher times out after interval + 1 s.
        let mut timed_out = false;
        for _ in 0..50 {
            if timeouts().await > 0 {
                timed_out = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(timed_out, "silence still times out");
        engine.stop_checks().await;
    }

    #[tokio::test]
    async fn uptime_cache_follows_beats_and_reloads_after_outside_writes() {
        // E4: the windows come from memory, are updated by each recorded
        // beat, and a write that bypassed the engine forces a reload.
        let (pool, engine) = scratch_engine().await;
        let monitor = sqlx::query_as::<_, Monitor>(
            "INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING *",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let stamp = |seconds_ago: i64| {
            (chrono::Utc::now() - chrono::Duration::seconds(seconds_ago))
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        };
        sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?)")
            .bind(monitor.id)
            .bind(stamp(3600))
            .bind(UP)
            .execute(&pool)
            .await
            .unwrap();

        let first = engine.uptime_windows(monitor.id).await;
        assert_eq!(first.day, Some(1.0));

        // A DOWN recorded through the engine lands in the cache directly.
        let recorded = engine
            .record_heartbeat(&monitor, DOWN, None, "boom", true)
            .await
            .unwrap();
        {
            let cache = engine.uptime.lock().unwrap();
            match cache.get(&monitor.id) {
                Some(UptimeEntry::Runs { runs, .. }) => {
                    assert_eq!(runs.last_id, Some(recorded.beat.id));
                    assert_eq!(runs.len(), 2);
                }
                _ => panic!("the entry stays a maintained run list"),
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let after = engine.uptime_windows(monitor.id).await;
        assert!(after.day.unwrap() < 1.0, "the DOWN run counts: {after:?}");

        // Someone rewrites history behind the engine's back.
        sqlx::query("DELETE FROM heartbeats WHERE monitor_id = ?")
            .bind(monitor.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?)")
            .bind(monitor.id)
            .bind(stamp(7200))
            .bind(DOWN)
            .execute(&pool)
            .await
            .unwrap();
        engine
            .record_heartbeat(&monitor, UP, None, "ok", false)
            .await
            .unwrap();
        let healed = engine.uptime_windows(monitor.id).await;
        let sql = heartbeats::uptime_windows(&pool, monitor.id).await.unwrap();
        assert!(
            (healed.day.unwrap() - sql.day.unwrap()).abs() < 1e-3,
            "reloaded from the database: {healed:?} vs {sql:?}"
        );
    }

    #[tokio::test]
    async fn stop_checks_ends_loops_and_liveness_follows() {
        let (pool, engine) = scratch_engine().await;
        sqlx::query(
            "INSERT INTO monitors (name, type, url, interval, timeout) VALUES ('dead', 'http', ?, 1, 1)",
        )
        .bind(closed_port_url().await)
        .execute(&pool)
        .await
        .unwrap();

        assert!(engine.liveness().check().is_err(), "inert before start_all");
        engine.start_all().await;
        let live = engine.liveness();
        assert!(live.check().is_ok(), "{live:?}");
        assert_eq!(live.loops, 1);

        let started = Instant::now();
        engine.stop_checks().await;
        assert!(started.elapsed() < LOOP_GRACE + Duration::from_millis(500));
        let stopped = engine.liveness();
        assert_eq!(stopped.loops, 0);
        assert_eq!(stopped.check(), Err("engine not running"));

        // Restarts after shutdown are no-ops.
        engine.restart(1).await;
        assert_eq!(engine.liveness().loops, 0);
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
