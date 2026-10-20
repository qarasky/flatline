//! Heartbeat model, status transitions and time-weighted uptime windows.
//!
//! The transition rules mirror the Node backend exactly (`determineStatus`
//! on the push route, `isImportantBeat` / `isImportantForNotification`, the
//! down-resend counter). Uptime is computed from heartbeats — time-weighted
//! — instead of the old aggregate tables: the deliberate simplification the
//! new schema allows.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use sqlx::SqlitePool;

use crate::monitors::Monitor;

/// Node status codes, kept as integers on the wire.
pub const DOWN: i64 = 0;
pub const UP: i64 = 1;
pub const PENDING: i64 = 2;
pub const MAINTENANCE: i64 = 3;

/// UP <-> DOWN; other statuses pass through (Node `flipStatus`).
pub fn flip_status(status: i64) -> i64 {
    match status {
        UP => DOWN,
        DOWN => UP,
        other => other,
    }
}

/// One heartbeat row, in the exact column order the schema stores.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Beat {
    pub id: i64,
    pub monitor_id: i64,
    pub time: String,
    pub status: i64,
    pub ping: Option<f64>,
    pub msg: Option<String>,
    pub important: i64,
    pub retries: i64,
    pub down_count: i64,
    pub duration: i64,
}

/// The three uptime windows the SPA shows, as 0..1 ratios. `None` means the
/// window holds no up/down time to average yet (a fresh monitor).
#[derive(Debug, Clone, Copy, Default)]
pub struct UptimeWindows {
    pub day: Option<f64>,
    pub week: Option<f64>,
    pub month: Option<f64>,
}

/// Current UTC time in the Node format: `YYYY-MM-DD HH:MM:SS.mmm`.
pub fn now_millis() -> String {
    Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

/// Parse a stored heartbeat time; imported rows may lack milliseconds.
pub fn parse_time(raw: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.3f")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
        .ok()
}

/// Milliseconds since a stored time; `None` when it cannot be parsed.
///
/// Negative when the stored time is in the future (a backwards clock step);
/// callers that schedule from it must clamp (E6).
pub fn millis_since(raw: &str) -> Option<i64> {
    let then = parse_time(raw)?;
    Some((Utc::now().naive_utc() - then).num_milliseconds())
}

/// A stored time as epoch milliseconds (UTC).
pub fn time_ms(raw: &str) -> Option<i64> {
    parse_time(raw).map(|time| time.and_utc().timestamp_millis())
}

/// Latest heartbeat for a monitor.
pub async fn latest(pool: &SqlitePool, monitor_id: i64) -> sqlx::Result<Option<Beat>> {
    sqlx::query_as::<_, Beat>(
        "SELECT * FROM heartbeats WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1",
    )
    .bind(monitor_id)
    .fetch_optional(pool)
    .await
}

/// How long heartbeats are kept by default, in days.
///
/// Every completed check writes a row, so a long-lived monitor grows its
/// history without bound (about 1.58M rows per monitor per year at a 20s
/// interval). Every read path stays inside this window: uptime windows are
/// at most 30 days, badges use 24h, status pages use 24h plus the incident
/// history, and the heartbeat list is bounded by its `limit`. The value is
/// configurable (`FLATLINE_HEARTBEAT_RETENTION_DAYS`, 0 disables pruning)
/// for operators who want more raw history.
pub const DEFAULT_RETENTION_DAYS: i64 = 90;

/// Delete heartbeats older than the retention window, keeping one boundary
/// sample per monitor.
///
/// The boundary sample — the newest beat before the cutoff — is what keeps
/// time-weighted uptime honest: a window that starts before it still has a
/// starting state to carry forward instead of a gap. Everything else older
/// than the cutoff goes; state transitions inside the window stay, so the
/// incident history matches the retained period. `retention_days <= 0`
/// disables pruning entirely.
pub async fn prune(pool: &SqlitePool, retention_days: i64) -> sqlx::Result<u64> {
    if retention_days <= 0 {
        return Ok(0);
    }

    let cutoff = (Utc::now() - ChronoDuration::days(retention_days))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();

    let result = sqlx::query(
        "DELETE FROM heartbeats
         WHERE time < ?
           AND id NOT IN (
               SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (
                       PARTITION BY monitor_id ORDER BY time DESC, id DESC
                   ) AS rn
                   FROM heartbeats WHERE time < ?
               ) WHERE rn = 1
           )",
    )
    .bind(&cutoff)
    .bind(&cutoff)
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}

/// The status walk of the Node push route (`determineStatus`): requested is
/// UP or DOWN as pushed; `explicit_down` bypasses the retry walk. Returns
/// `(status, retries)`.
pub fn determine_status(
    requested: i64,
    previous: Option<&Beat>,
    maxretries: i64,
    upside_down: bool,
    explicit_down: bool,
) -> (i64, i64) {
    let status = if upside_down {
        flip_status(requested)
    } else {
        requested
    };

    if explicit_down && status == DOWN {
        return (DOWN, 0);
    }

    match previous {
        Some(prev) => {
            if prev.status == UP && status == DOWN {
                if maxretries > 0 && prev.retries < maxretries {
                    (PENDING, prev.retries + 1)
                } else {
                    (DOWN, 0)
                }
            } else if prev.status == PENDING && status == DOWN && prev.retries < maxretries {
                (PENDING, prev.retries + 1)
            } else if status == DOWN {
                (status, prev.retries + 1)
            } else {
                (status, 0)
            }
        }
        None => {
            if status == DOWN && maxretries > 0 {
                (PENDING, 1)
            } else {
                (status, 0)
            }
        }
    }
}

/// `isImportantBeat`: a state transition (or the first beat) marks the row.
pub fn is_important_beat(is_first: bool, previous: Option<i64>, current: i64) -> bool {
    is_first
        || (previous == Some(DOWN) && current == MAINTENANCE)
        || (previous == Some(UP) && current == MAINTENANCE)
        || (previous == Some(MAINTENANCE) && current == DOWN)
        || (previous == Some(MAINTENANCE) && current == UP)
        || (previous == Some(UP) && current == DOWN)
        || (previous == Some(DOWN) && current == UP)
        || (previous == Some(PENDING) && current == DOWN)
}

/// `isImportantForNotification`: transitions worth a message. PENDING never
/// pages — a retry walk is silent by design.
pub fn is_important_for_notification(is_first: bool, previous: Option<i64>, current: i64) -> bool {
    is_first
        || (previous == Some(MAINTENANCE) && current == DOWN)
        || (previous == Some(UP) && current == DOWN)
        || (previous == Some(DOWN) && current == UP)
        || (previous == Some(PENDING) && current == DOWN)
}

/// What happened when a beat was recorded: enough for the caller to publish
/// and (optionally) notify.
pub struct Recorded {
    pub beat: Beat,
    pub is_first: bool,
    pub previous_status: Option<i64>,
    /// Id of the beat that was latest before this one (uptime cache check).
    pub previous_id: Option<i64>,
    pub notify: bool,
}

/// Record a heartbeat, applying the Node transition rules.
///
/// `requested` is UP or DOWN as pushed/observed; `explicit_down` bypasses
/// the retry walk (the agent pushed `status=down` on purpose).
/// `duration_override` lets the push-timeout path record the observed
/// silence length, exactly like the Node check loop does.
///
/// Serialized per monitor (E2): the push route and the push watcher (or two
/// concurrent pushes) used to read the same `latest()` and both insert a
/// transition — duplicate pages and a corrupted retry walk. Callers that
/// need more work under the same lock (the engine publishes and enqueues
/// the alert before releasing it, so alerts keep transition order) take
/// [`lock_monitor`] themselves and call [`record_locked`].
pub async fn record(
    pool: &SqlitePool,
    monitor: &Monitor,
    requested: i64,
    ping: Option<f64>,
    msg: &str,
    explicit_down: bool,
    duration_override: Option<i64>,
) -> sqlx::Result<Recorded> {
    let guard = lock_monitor(monitor.id).await;
    record_locked(
        &guard,
        pool,
        monitor,
        requested,
        ping,
        msg,
        explicit_down,
        duration_override,
    )
    .await
}

/// Held while a monitor's heartbeat state is read and written.
pub struct MonitorGuard {
    monitor_id: i64,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl MonitorGuard {
    pub fn monitor_id(&self) -> i64 {
        self.monitor_id
    }
}

/// One async lock per monitor id, process-wide.
///
/// The map holds one small entry per monitor id ever recorded; ids are not
/// reused (`AUTOINCREMENT`), so it is bounded by the number of monitors.
static RECORD_LOCKS: LazyLock<Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Take the per-monitor heartbeat lock (see [`record`]).
pub async fn lock_monitor(monitor_id: i64) -> MonitorGuard {
    let lock = {
        let mut locks = RECORD_LOCKS.lock().unwrap();
        Arc::clone(locks.entry(monitor_id).or_default())
    };
    MonitorGuard {
        monitor_id,
        _guard: lock.lock_owned().await,
    }
}

/// [`record`] for a caller that already holds the monitor's lock.
#[allow(clippy::too_many_arguments)]
pub async fn record_locked(
    guard: &MonitorGuard,
    pool: &SqlitePool,
    monitor: &Monitor,
    requested: i64,
    ping: Option<f64>,
    msg: &str,
    explicit_down: bool,
    duration_override: Option<i64>,
) -> sqlx::Result<Recorded> {
    debug_assert_eq!(guard.monitor_id, monitor.id, "lock for the wrong monitor");
    let previous = latest(pool, monitor.id).await?;
    let is_first = previous.is_none();
    let previous_status = previous.as_ref().map(|beat| beat.status);
    let previous_id = previous.as_ref().map(|beat| beat.id);

    let (status, retries) = determine_status(
        requested,
        previous.as_ref(),
        monitor.maxretries,
        monitor.upside_down != 0,
        explicit_down,
    );

    let now = now_millis();
    let duration = duration_override.unwrap_or_else(|| {
        previous
            .as_ref()
            .and_then(|beat| parse_time(&beat.time))
            .map(|then| {
                (parse_time(&now).unwrap_or(then) - then)
                    .num_seconds()
                    .max(0)
            })
            .unwrap_or(0)
    });

    let important = is_important_beat(is_first, previous_status, status);
    let important_for_notification =
        is_important_for_notification(is_first, previous_status, status);

    let mut down_count = previous.as_ref().map(|beat| beat.down_count).unwrap_or(0);
    let notify = if important_for_notification {
        // A state transition resets the resend walk.
        down_count = 0;
        // An initial UP is silence; an initial DOWN pages.
        !is_first || status == DOWN
    } else if status == DOWN && monitor.resend_interval > 0 {
        down_count += 1;
        if down_count >= monitor.resend_interval {
            down_count = 0;
            true
        } else {
            false
        }
    } else {
        false
    };

    let beat = sqlx::query_as::<_, Beat>(
        "INSERT INTO heartbeats
             (monitor_id, time, status, ping, msg, important, retries, down_count, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *",
    )
    .bind(monitor.id)
    .bind(&now)
    .bind(status)
    .bind(ping)
    .bind(msg)
    .bind(if important { 1 } else { 0 })
    .bind(retries)
    .bind(down_count)
    .bind(duration)
    .fetch_one(pool)
    .await?;

    Ok(Recorded {
        beat,
        is_first,
        previous_status,
        previous_id,
        notify,
    })
}

/// Uptime for one arbitrary window (badges, status pages), same
/// time-weighted rules as [`uptime_windows`].
pub async fn uptime_window(
    pool: &SqlitePool,
    monitor_id: i64,
    window_seconds: i64,
) -> sqlx::Result<Option<f64>> {
    let start = (Utc::now() - ChronoDuration::seconds(window_seconds))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();

    let (up, down): (f64, f64) = sqlx::query_as(
        "WITH relevant AS (
             SELECT time, status, 0 AS before_window
             FROM heartbeats WHERE monitor_id = ? AND time >= ?
             UNION ALL
             SELECT time, status, 1 AS before_window FROM (
                 SELECT time, status FROM heartbeats
                 WHERE monitor_id = ? AND time < ?
                 ORDER BY time DESC, id DESC LIMIT 1
             )
         ),
         ordered AS (
             SELECT status,
                    CASE WHEN before_window = 1 THEN julianday(?) ELSE julianday(time) END AS t0,
                    julianday(COALESCE(LEAD(time) OVER (ORDER BY time), 'now')) AS t1
             FROM relevant
         )
         SELECT
             COALESCE(SUM(CASE WHEN status = 1 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0,
             COALESCE(SUM(CASE WHEN status = 0 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0
         FROM ordered",
    )
    .bind(monitor_id)
    .bind(&start)
    .bind(monitor_id)
    .bind(&start)
    .bind(&start)
    .bind(&start)
    .bind(&start)
    .fetch_one(pool)
    .await?;

    let total = up + down;
    if total <= 0.0 {
        Ok(None)
    } else {
        Ok(Some((up / total).clamp(0.0, 1.0)))
    }
}

/// All three SPA windows in one pass over the last 30 days of heartbeats.
///
/// The status of a beat holds until the next beat; the newest beat holds
/// until now, and the latest beat before the 30-day window holds from the
/// window start. Only UP and DOWN contribute, matching the Node calculator
/// (`uptime = up / (up + down)`); pending time is neither.
pub async fn uptime_windows(pool: &SqlitePool, monitor_id: i64) -> sqlx::Result<UptimeWindows> {
    let now = Utc::now();
    let start = |seconds: i64| {
        (now - ChronoDuration::seconds(seconds))
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string()
    };
    let day = start(24 * 3600);
    let week = start(7 * 24 * 3600);
    let month = start(30 * 24 * 3600);

    let (up_day, down_day, up_week, down_week, up_month, down_month): (
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
    ) = sqlx::query_as(
        "WITH relevant AS (
             SELECT time, status, 0 AS before_window
             FROM heartbeats WHERE monitor_id = ? AND time >= ?
             UNION ALL
             SELECT time, status, 1 AS before_window FROM (
                 SELECT time, status FROM heartbeats
                 WHERE monitor_id = ? AND time < ?
                 ORDER BY time DESC, id DESC LIMIT 1
             )
         ),
         ordered AS (
             SELECT status,
                    CASE WHEN before_window = 1 THEN julianday(?) ELSE julianday(time) END AS t0,
                    julianday(COALESCE(LEAD(time) OVER (ORDER BY time), 'now')) AS t1
             FROM relevant
         )
         SELECT
             COALESCE(SUM(CASE WHEN status = 1 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0,
             COALESCE(SUM(CASE WHEN status = 0 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0,
             COALESCE(SUM(CASE WHEN status = 1 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0,
             COALESCE(SUM(CASE WHEN status = 0 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0,
             COALESCE(SUM(CASE WHEN status = 1 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0,
             COALESCE(SUM(CASE WHEN status = 0 THEN MAX(0.0, t1 - MAX(t0, julianday(?))) END), 0.0) * 86400.0
         FROM ordered",
    )
    .bind(monitor_id)
    .bind(&month)
    .bind(monitor_id)
    .bind(&month)
    .bind(&month)
    .bind(&day)
    .bind(&day)
    .bind(&week)
    .bind(&week)
    .bind(&month)
    .bind(&month)
    .fetch_one(pool)
    .await?;

    let ratio = |up: f64, down: f64| {
        let total = up + down;
        if total <= 0.0 {
            None
        } else {
            Some((up / total).clamp(0.0, 1.0))
        }
    };

    Ok(UptimeWindows {
        day: ratio(up_day, down_day),
        week: ratio(up_week, down_week),
        month: ratio(up_month, down_month),
    })
}

/// The longest SPA window, in milliseconds.
const MONTH_MS: i64 = 30 * 24 * 3600 * 1000;
const WEEK_MS: i64 = 7 * 24 * 3600 * 1000;
const DAY_MS: i64 = 24 * 3600 * 1000;

/// One status run: the status that holds from `start_ms` until the next
/// run starts (or until now for the newest run).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Run {
    pub start_ms: i64,
    pub status: i64,
}

/// Incrementally maintained uptime state for one monitor (E4).
///
/// Time-weighted uptime depends only on *when the status changed*: a beat
/// that repeats the previous status extends the current run. So the 30-day
/// history collapses to one entry per transition — a handful for a healthy
/// monitor — and the three windows are computed from memory with the same
/// rules as [`uptime_windows`] (the status of a run holds until the next
/// one, the newest holds until now, only UP and DOWN count). Recording a
/// beat appends in O(1); nothing on the check path rescans 30 days.
#[derive(Debug, Clone, Default)]
pub struct UptimeRuns {
    runs: VecDeque<Run>,
    /// Id of the newest beat folded in, so a writer that bypassed the cache
    /// (or a reused id) is detected and the entry is reloaded.
    pub last_id: Option<i64>,
}

impl UptimeRuns {
    pub fn from_runs(runs: Vec<Run>, last_id: Option<i64>) -> Self {
        Self {
            runs: runs.into(),
            last_id,
        }
    }

    pub fn len(&self) -> usize {
        self.runs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// Fold one new beat in.
    pub fn push(&mut self, beat_id: i64, time_ms: i64, status: i64) {
        self.last_id = Some(beat_id);
        match self.runs.back() {
            Some(last) if last.status == status => {}
            // A beat stamped before the current run (a backwards clock step)
            // starts its run where the current one started instead of
            // reordering history.
            Some(last) => {
                let start_ms = time_ms.max(last.start_ms);
                self.runs.push_back(Run { start_ms, status });
            }
            None => self.runs.push_back(Run {
                start_ms: time_ms,
                status,
            }),
        }
    }

    /// Drop runs that ended before the 30-day window; the run spanning the
    /// window start stays (it is the carried-forward starting state).
    pub fn trim(&mut self, now_ms: i64) {
        let start = now_ms - MONTH_MS;
        while self.runs.len() >= 2 && self.runs[1].start_ms <= start {
            self.runs.pop_front();
        }
    }

    /// The three SPA windows at `now_ms`.
    pub fn windows(&self, now_ms: i64) -> UptimeWindows {
        let starts = [now_ms - DAY_MS, now_ms - WEEK_MS, now_ms - MONTH_MS];
        let mut up = [0i64; 3];
        let mut down = [0i64; 3];

        let mut end = now_ms;
        for run in self.runs.iter().rev() {
            if end <= starts[2] {
                break;
            }
            for (index, start) in starts.iter().enumerate() {
                let overlap = (end - run.start_ms.max(*start)).max(0);
                match run.status {
                    UP => up[index] += overlap,
                    DOWN => down[index] += overlap,
                    _ => {}
                }
            }
            // A run stamped in the future (clock step) cannot extend the
            // previous one past its own start.
            end = run.start_ms.min(end);
        }

        let ratio = |up: i64, down: i64| {
            let total = up + down;
            if total <= 0 {
                None
            } else {
                Some((up as f64 / total as f64).clamp(0.0, 1.0))
            }
        };
        UptimeWindows {
            day: ratio(up[0], down[0]),
            week: ratio(up[1], down[1]),
            month: ratio(up[2], down[2]),
        }
    }
}

/// Load a monitor's status runs for the last 30 days (plus the run that
/// was current at the window start) — the one 30-day scan, done once per
/// cache fill instead of every 30 s per monitor.
pub async fn load_runs(pool: &SqlitePool, monitor_id: i64) -> sqlx::Result<UptimeRuns> {
    let month = (Utc::now() - ChronoDuration::milliseconds(MONTH_MS))
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();

    let rows: Vec<(String, i64)> = sqlx::query_as(
        "WITH relevant AS (
             SELECT id, time, status FROM heartbeats WHERE monitor_id = ? AND time >= ?
             UNION ALL
             SELECT id, time, status FROM (
                 SELECT id, time, status FROM heartbeats
                 WHERE monitor_id = ? AND time < ?
                 ORDER BY time DESC, id DESC LIMIT 1
             )
         ),
         ordered AS (
             SELECT time, status, LAG(status) OVER (ORDER BY time, id) AS previous
             FROM relevant
         )
         SELECT time, status FROM ordered
         WHERE previous IS NULL OR previous <> status
         ORDER BY time",
    )
    .bind(monitor_id)
    .bind(&month)
    .bind(monitor_id)
    .bind(&month)
    .fetch_all(pool)
    .await?;

    let last_id = latest(pool, monitor_id).await?.map(|beat| beat.id);
    let runs = rows
        .into_iter()
        .filter_map(|(time, status)| {
            Some(Run {
                start_ms: time_ms(&time)?,
                status,
            })
        })
        .collect();
    Ok(UptimeRuns::from_runs(runs, last_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn test_pool() -> SqlitePool {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep();
        crate::db::connect(&path).await.unwrap()
    }

    async fn insert_beat(pool: &SqlitePool, monitor_id: i64, time: &str, status: i64) {
        sqlx::query("INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?)")
            .bind(monitor_id)
            .bind(time)
            .bind(status)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_monitor(pool: &SqlitePool) -> Monitor {
        sqlx::query_as::<_, Monitor>(
            "INSERT INTO monitors (name, type) VALUES ('m', 'push') RETURNING *",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn beat(status: i64, retries: i64) -> Beat {
        Beat {
            id: 1,
            monitor_id: 1,
            time: now_millis(),
            status,
            ping: None,
            msg: None,
            important: 0,
            retries,
            down_count: 0,
            duration: 0,
        }
    }

    #[test]
    fn retry_walk_matches_node() {
        // First DOWN with retries available goes PENDING.
        assert_eq!(determine_status(DOWN, None, 2, false, false), (PENDING, 1));
        // First DOWN without retries goes straight DOWN.
        assert_eq!(determine_status(DOWN, None, 0, false, false), (DOWN, 0));
        // UP -> DOWN with retries available: PENDING, retry counter up.
        let up = beat(UP, 0);
        assert_eq!(
            determine_status(DOWN, Some(&up), 2, false, false),
            (PENDING, 1)
        );
        // PENDING -> DOWN until retries are spent.
        let pending = beat(PENDING, 1);
        assert_eq!(
            determine_status(DOWN, Some(&pending), 2, false, false),
            (PENDING, 2)
        );
        let pending = beat(PENDING, 2);
        assert_eq!(
            determine_status(DOWN, Some(&pending), 2, false, false),
            (DOWN, 3)
        );
        // Recovery resets retries.
        let down = beat(DOWN, 3);
        assert_eq!(determine_status(UP, Some(&down), 2, false, false), (UP, 0));
        // Explicit down bypasses the walk.
        assert_eq!(determine_status(DOWN, Some(&up), 2, false, true), (DOWN, 0));
        // Upside down flips the requested status.
        assert_eq!(determine_status(UP, Some(&down), 0, true, false), (DOWN, 4));
    }

    #[test]
    fn importance_matches_node() {
        assert!(is_important_beat(true, None, UP));
        assert!(is_important_beat(false, Some(UP), DOWN));
        assert!(is_important_beat(false, Some(DOWN), UP));
        assert!(is_important_beat(false, Some(PENDING), DOWN));
        assert!(!is_important_beat(false, Some(UP), PENDING));
        assert!(!is_important_beat(false, Some(DOWN), DOWN));
        assert!(!is_important_beat(false, Some(PENDING), UP));

        assert!(is_important_for_notification(true, None, UP));
        assert!(is_important_for_notification(false, Some(UP), DOWN));
        assert!(is_important_for_notification(false, Some(DOWN), UP));
        assert!(is_important_for_notification(false, Some(PENDING), DOWN));
        // PENDING never pages.
        assert!(!is_important_for_notification(false, Some(UP), PENDING));
    }

    #[tokio::test]
    async fn record_applies_resend_walk_and_first_beat_rules() {
        let pool = test_pool().await;
        let monitor = insert_monitor(&pool).await;

        // First UP beat: important, but silent (no notification).
        let recorded = record(&pool, &monitor, UP, Some(12.0), "200 - OK", false, None)
            .await
            .unwrap();
        assert_eq!(recorded.beat.status, UP);
        assert_eq!(recorded.beat.important, 1);
        assert!(!recorded.notify);

        // UP -> DOWN with maxretries 0 pages once.
        let recorded = record(&pool, &monitor, DOWN, None, "boom", false, None)
            .await
            .unwrap();
        assert_eq!(recorded.beat.status, DOWN);
        assert!(recorded.notify);
        assert_eq!(recorded.beat.down_count, 0);

        // A repeat DOWN does not notify without a resend interval.
        let recorded = record(&pool, &monitor, DOWN, None, "boom", false, None)
            .await
            .unwrap();
        assert!(!recorded.notify);
    }

    #[tokio::test]
    async fn prune_keeps_recent_beats_and_one_boundary_sample() {
        let pool = test_pool().await;
        let monitor = insert_monitor(&pool).await;
        let other = insert_monitor(&pool).await;

        let now = Utc::now();
        let stamp = |seconds_ago: i64| {
            (now - ChronoDuration::seconds(seconds_ago))
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        };
        let day = 24 * 3600;

        // Two monitors, one with three beats older than the 90-day cutoff
        // and a fresh one, one with two old beats (its newest old beat is its
        // boundary and must survive too).
        insert_beat(&pool, monitor.id, &stamp(100 * day), UP).await;
        insert_beat(&pool, monitor.id, &stamp(95 * day), UP).await;
        let boundary = {
            sqlx::query_as::<_, Beat>(
                "INSERT INTO heartbeats (monitor_id, time, status) VALUES (?, ?, ?) RETURNING *",
            )
            .bind(monitor.id)
            .bind(stamp(92 * day))
            .bind(DOWN)
            .fetch_one(&pool)
            .await
            .unwrap()
        };
        insert_beat(&pool, monitor.id, &stamp(day), UP).await;
        insert_beat(&pool, other.id, &stamp(250 * day), UP).await;
        insert_beat(&pool, other.id, &stamp(200 * day), DOWN).await;

        let deleted = prune(&pool, 90).await.unwrap();
        assert_eq!(deleted, 3, "old beats beyond the boundary are deleted");

        let left: Vec<(i64, String)> =
            sqlx::query_as("SELECT monitor_id, time FROM heartbeats ORDER BY time")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(left.len(), 3);
        // The newest pre-cutoff beat of each monitor survives: the starting
        // state a window reaching past the cutoff carries forward.
        assert!(
            left.iter()
                .any(|(id, time)| *id == monitor.id && *time == boundary.time)
        );
        assert!(
            left.iter()
                .any(|(id, time)| *id == other.id && *time == stamp(200 * day))
        );
        assert!(
            left.iter()
                .any(|(id, time)| *id == monitor.id && *time == stamp(day)),
            "beats inside the retention window survive"
        );

        // The boundary sample keeps time-weighted uptime honest across the
        // cut: the DOWN that was current when the window started still counts
        // (29 days down, then 1 day up -> ~3.3%), instead of the window
        // silently starting at the first retained beat and reporting a
        // misleading 100%.
        let uptime = uptime_window(&pool, monitor.id, 30 * day).await.unwrap();
        let ratio = uptime.expect("retained beats cover the window");
        assert!(
            (ratio - 1.0 / 30.0).abs() < 0.01,
            "expected ~0.033 from the boundary DOWN, got {ratio}"
        );

        // Zero retention means "keep everything".
        assert_eq!(prune(&pool, 0).await.unwrap(), 0);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn uptime_is_time_weighted() {
        let pool = test_pool().await;
        let monitor = insert_monitor(&pool).await;

        let now = Utc::now();
        let stamp = |seconds_ago: i64| {
            (now - ChronoDuration::seconds(seconds_ago))
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        };

        // One hour UP, one hour DOWN, then UP until now.
        insert_beat(&pool, monitor.id, &stamp(3 * 3600), UP).await;
        insert_beat(&pool, monitor.id, &stamp(2 * 3600), DOWN).await;
        insert_beat(&pool, monitor.id, &stamp(3600), UP).await;

        let windows = uptime_windows(&pool, monitor.id).await.unwrap();
        let day = windows.day.unwrap();
        // 3h covered: 2h up, 1h down.
        assert!((day - 2.0 / 3.0).abs() < 0.01, "expected ~0.667, got {day}");
        // The 7d and 30d windows cover the same three hours.
        assert!(windows.week.unwrap() > 0.6);
        assert!(windows.month.unwrap() > 0.6);

        // A fresh monitor with no beats has no ratio at all.
        let fresh = insert_monitor(&pool).await;
        let windows = uptime_windows(&pool, fresh.id).await.unwrap();
        assert!(windows.day.is_none());
        assert!(windows.week.is_none());
        assert!(windows.month.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_records_produce_one_transition() {
        // E2: the push route and the push watcher (or two pushes) racing on
        // the same monitor used to both read UP as the previous beat and
        // both insert an important DOWN that pages.
        let pool = test_pool().await;
        let monitor = insert_monitor(&pool).await;
        record(&pool, &monitor, UP, None, "ok", false, None)
            .await
            .unwrap();

        let mut tasks = Vec::new();
        for _ in 0..16 {
            let pool = pool.clone();
            let monitor = monitor.clone();
            tasks.push(tokio::spawn(async move {
                record(&pool, &monitor, DOWN, None, "boom", false, None)
                    .await
                    .unwrap()
            }));
        }
        let mut notified = 0;
        for task in tasks {
            if task.await.unwrap().notify {
                notified += 1;
            }
        }
        assert_eq!(notified, 1, "exactly one recorder sees the transition");

        let important: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ? AND important = 1 AND status = ?",
        )
        .bind(monitor.id)
        .bind(DOWN)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(important, 1, "one important DOWN row, not one per racer");
    }

    #[tokio::test]
    async fn incremental_runs_match_the_sql_windows() {
        // E4: the in-memory run list must agree with the 30-day SQL scan,
        // both when loaded and when maintained beat by beat.
        let pool = test_pool().await;
        let monitor = insert_monitor(&pool).await;
        let now = Utc::now();
        let stamp = |ms_ago: i64| {
            (now - ChronoDuration::milliseconds(ms_ago))
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        };

        // 40 days of history: a beat every 6h with a deterministic mix of
        // statuses, including a boundary run before the 30-day start and
        // repeated statuses that collapse into one run.
        let statuses = [UP, UP, DOWN, DOWN, UP, PENDING, UP, DOWN, UP, UP, UP];
        let step = 6 * 3600 * 1000;
        let total = 40 * 4;
        for index in 0..total {
            let ms_ago = (total - index) * step + 1234;
            insert_beat(&pool, monitor.id, &stamp(ms_ago), statuses[index as usize % statuses.len()]).await;
        }

        let close = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => (a - b).abs() < 1e-6,
            (None, None) => true,
            _ => false,
        };
        let check = |runs: &UptimeRuns, sql: &UptimeWindows| {
            let mem = runs.windows(Utc::now().timestamp_millis());
            assert!(close(mem.day, sql.day), "day {mem:?} vs {sql:?}");
            assert!(close(mem.week, sql.week), "week {mem:?} vs {sql:?}");
            assert!(close(mem.month, sql.month), "month {mem:?} vs {sql:?}");
        };

        let mut runs = load_runs(&pool, monitor.id).await.unwrap();
        assert!(runs.len() < 120, "repeats collapse into runs ({})", runs.len());
        check(&runs, &uptime_windows(&pool, monitor.id).await.unwrap());

        // Maintained incrementally through `record`, it stays exact.
        for status in [DOWN, DOWN, UP, DOWN, UP] {
            let recorded = record(&pool, &monitor, status, None, "x", true, None)
                .await
                .unwrap();
            assert_eq!(runs.last_id, recorded.previous_id, "chain is unbroken");
            runs.push(
                recorded.beat.id,
                time_ms(&recorded.beat.time).unwrap(),
                recorded.beat.status,
            );
            runs.trim(Utc::now().timestamp_millis());
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
        check(&runs, &uptime_windows(&pool, monitor.id).await.unwrap());

        // An empty monitor has no ratio either way.
        let fresh = insert_monitor(&pool).await;
        let empty = load_runs(&pool, fresh.id).await.unwrap();
        assert!(empty.is_empty() && empty.last_id.is_none());
        let windows = empty.windows(Utc::now().timestamp_millis());
        assert!(windows.day.is_none() && windows.month.is_none());
    }
}
