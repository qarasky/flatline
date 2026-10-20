//! Rolling 10-minute CPU peak (`cpu-peak.js`).
//!
//! The Superboard wants "how hot did this box get recently", not just the
//! current reading. A monotonic queue per monitor keeps the window maximum
//! at O(1) and is seeded from archived samples after a restart, so the peak
//! survives the cache being cold.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

use crate::metrics::lru::{CACHE_MONITORS, Recency};
use crate::metrics::{Metrics, history, iso_millis, metric_time, sql_time_millis};

/// Peak window length.
pub const WINDOW_MS: i64 = 10 * 60_000;
/// Normal 1Hz windows contain at most 600 entries; bound abusive faster
/// senders too, retaining the highest candidates rather than losing them.
const MAX_QUEUE: usize = 2048;

#[derive(Debug, Clone, Serialize)]
pub struct Peak {
    pub percent: f64,
    pub at: String,
}

#[derive(Clone, Copy)]
struct Entry {
    time: i64,
    percent: f64,
}

#[derive(Default)]
struct Queue {
    entries: VecDeque<Entry>,
    last_time: i64,
}

#[derive(Default)]
pub struct PeakState {
    windows: HashMap<i64, Queue>,
    /// Least-recently-recorded windows are evicted first: an active monitor
    /// must never lose its window to an idle one.
    order: Recency,
}

impl PeakState {
    pub fn is_warm(&self, monitor_id: i64) -> bool {
        self.windows.contains_key(&monitor_id)
    }

    /// Seed a monitor's window from archived rows (newest first).
    pub fn warm(&mut self, monitor_id: i64, rows: &[history::ScalarRow]) {
        if self.windows.contains_key(&monitor_id) {
            return;
        }

        let mut queue = Queue::default();
        for row in rows.iter().rev() {
            if let Some(time) = metric_time(&row.time) {
                add(
                    &mut queue,
                    time,
                    row.cpu
                        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value)),
                );
            }
        }
        // The newest row defines the window's edge (Node reads `rows.at(-1)`
        // after reversing).
        queue.last_time = rows
            .first()
            .and_then(|row| metric_time(&row.time))
            .unwrap_or(i64::MIN);

        while self.windows.len() >= CACHE_MONITORS {
            let Some(oldest) = self.order.pop_oldest() else {
                break;
            };
            self.windows.remove(&oldest);
        }
        self.order.touch(monitor_id);
        self.windows.insert(monitor_id, queue);
    }

    /// The current window peak at `now`; prunes expired entries first.
    pub fn current(&mut self, monitor_id: i64, now: i64) -> Option<Peak> {
        let queue = self.windows.get_mut(&monitor_id)?;
        current_at(queue, now)
    }

    /// Record a reading and return the peak for the window ending at the
    /// later of the sample time and the last recorded time.
    pub fn record(&mut self, monitor_id: i64, time: i64, percent: Option<f64>) -> Option<Peak> {
        let queue = self.windows.get_mut(&monitor_id)?;
        self.order.touch(monitor_id);
        let end = time.max(queue.last_time);
        let _ = current_at(queue, end);
        if time >= queue.last_time {
            add(queue, time, percent);
            queue.last_time = time;
        }
        current_at(queue, end)
    }

    pub fn forget(&mut self, monitor_id: i64) {
        self.windows.remove(&monitor_id);
        self.order.remove(monitor_id);
    }
}

/// Push a reading onto the monotonic queue: pop everything at or below it
/// from the back, so the head is always the window maximum.
fn add(queue: &mut Queue, time: i64, percent: Option<f64>) {
    let Some(percent) = percent else {
        return;
    };
    while let Some(back) = queue.entries.back() {
        if back.percent <= percent {
            queue.entries.pop_back();
        } else {
            break;
        }
    }
    queue.entries.push_back(Entry { time, percent });
    if queue.entries.len() > MAX_QUEUE {
        queue.entries.remove(1);
    }
}

fn current_at(queue: &mut Queue, now: i64) -> Option<Peak> {
    while let Some(front) = queue.entries.front() {
        if front.time < now - WINDOW_MS {
            queue.entries.pop_front();
        } else {
            break;
        }
    }
    queue.entries.front().map(|entry| Peak {
        percent: entry.percent,
        at: iso_millis(entry.time),
    })
}

impl Metrics {
    /// Record one reading into a monitor's peak window, warming from the
    /// database on first sight.
    pub(crate) async fn record_cpu_peak(
        &self,
        monitor_id: i64,
        time_ms: i64,
        percent: Option<f64>,
    ) -> Option<Peak> {
        let warm = {
            let state = self.peak.lock().unwrap();
            state.is_warm(monitor_id)
        };
        if !warm {
            let from = sql_time_millis(time_ms - WINDOW_MS);
            let to = sql_time_millis(time_ms);
            let rows = history::scalar_rows(&self.pool, monitor_id, &from, &to, MAX_QUEUE)
                .await
                .unwrap_or_default();
            self.peak.lock().unwrap().warm(monitor_id, &rows);
        }

        let mut state = self.peak.lock().unwrap();
        state.record(monitor_id, time_ms, percent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warm_state(id: i64) -> PeakState {
        let mut state = PeakState::default();
        state.warm(id, &[]);
        state
    }

    #[test]
    fn peak_keeps_the_window_maximum() {
        let mut state = warm_state(1);
        let now = 1_000_000_000_i64;

        assert!(state.record(1, now, Some(10.0)).is_some());
        assert_eq!(
            state.record(1, now + 1_000, Some(5.0)).unwrap().percent,
            10.0
        );
        let peak = state.record(1, now + 2_000, Some(90.0)).unwrap();
        assert_eq!(peak.percent, 90.0);
        assert_eq!(peak.at, iso_millis(now + 2_000));

        // A newer reading below the peak does not replace it...
        assert_eq!(
            state.record(1, now + 3_000, Some(20.0)).unwrap().percent,
            90.0
        );
        // ...until the peak falls out of the 10-minute window.
        assert_eq!(
            state
                .record(1, now + WINDOW_MS + 2_001, Some(20.0))
                .unwrap()
                .percent,
            20.0
        );
    }

    #[test]
    fn out_of_order_samples_do_not_move_the_clock() {
        let mut state = warm_state(2);
        let now = 2_000_000_000_i64;
        state.record(2, now, Some(50.0));
        // An older sample is not recorded at all (Node's `now >= lastTime`
        // gate) and does not move the window edge.
        let peak = state.record(2, now - 1_000, Some(70.0)).unwrap();
        assert_eq!(peak.percent, 50.0, "out-of-order samples are ignored");
        assert_eq!(
            state.record(2, now + 1_000, Some(10.0)).unwrap().percent,
            50.0
        );
    }

    #[test]
    fn eviction_is_least_recently_recorded() {
        let mut state = PeakState::default();
        for id in 0..CACHE_MONITORS as i64 {
            state.warm(id, &[]);
        }
        // Monitor 0 was warmed first but keeps recording: it must survive.
        state.record(0, 1_000, Some(10.0));
        state.warm(CACHE_MONITORS as i64, &[]);
        assert!(state.is_warm(0), "an active window is never the one evicted");
        assert!(!state.is_warm(1), "the least recently used window goes");
        assert!(state.is_warm(CACHE_MONITORS as i64));
    }

    #[test]
    fn forget_drops_the_window() {
        let mut state = warm_state(3);
        state.record(3, 1_000, Some(10.0));
        state.forget(3);
        assert!(!state.is_warm(3));
        assert!(state.current(3, 2_000).is_none());
    }
}
