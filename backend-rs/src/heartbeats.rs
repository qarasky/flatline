//! Heartbeat model, status transitions and time-weighted uptime windows.
//!
//! The transition rules mirror the Node backend exactly (`determineStatus`
//! on the push route, `isImportantBeat` / `isImportantForNotification`, the
//! down-resend counter). Uptime is computed from heartbeats — time-weighted
//! — instead of the old aggregate tables: the deliberate simplification the
//! new schema allows.

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
pub fn millis_since(raw: &str) -> Option<i64> {
    let then = parse_time(raw)?;
    Some((Utc::now().naive_utc() - then).num_milliseconds())
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
    pub notify: bool,
}

/// Record a heartbeat, applying the Node transition rules.
///
/// `requested` is UP or DOWN as pushed/observed; `explicit_down` bypasses
/// the retry walk (the agent pushed `status=down` on purpose).
/// `duration_override` lets the push-timeout path record the observed
/// silence length, exactly like the Node check loop does.
pub async fn record(
    pool: &SqlitePool,
    monitor: &Monitor,
    requested: i64,
    ping: Option<f64>,
    msg: &str,
    explicit_down: bool,
    duration_override: Option<i64>,
) -> sqlx::Result<Recorded> {
    let previous = latest(pool, monitor.id).await?;
    let is_first = previous.is_none();
    let previous_status = previous.as_ref().map(|beat| beat.status);

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
        notify,
    })
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
}
