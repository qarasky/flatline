//! Recency order for the bounded per-monitor caches (latest sample, CPU
//! peak windows).
//!
//! Both caches used to evict in insertion order: past the bound, the monitor
//! inserted first was dropped even when it pushed a second ago, and an active
//! monitor evicted that way lost its archive clock, counter windows and peak
//! window. This keeps true least-recently-used order: every update touches.

use std::collections::{BTreeMap, HashMap};

/// Monitors the per-monitor caches hold before evicting. An entry is a few
/// KB in practice (one sample plus counter snapshots), at most ~64 KB.
pub const CACHE_MONITORS: usize = 2048;

#[derive(Default)]
pub(crate) struct Recency {
    tick: u64,
    by_id: HashMap<i64, u64>,
    by_tick: BTreeMap<u64, i64>,
}

impl Recency {
    /// Mark `id` as the most recently used.
    pub fn touch(&mut self, id: i64) {
        self.tick += 1;
        if let Some(previous) = self.by_id.insert(id, self.tick) {
            self.by_tick.remove(&previous);
        }
        self.by_tick.insert(self.tick, id);
    }

    pub fn remove(&mut self, id: i64) {
        if let Some(tick) = self.by_id.remove(&id) {
            self.by_tick.remove(&tick);
        }
    }

    /// Remove and return the least recently used id.
    pub fn pop_oldest(&mut self) -> Option<i64> {
        let (_, id) = self.by_tick.pop_first()?;
        self.by_id.remove(&id);
        Some(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_moves_an_id_to_the_back() {
        let mut order = Recency::default();
        order.touch(1);
        order.touch(2);
        order.touch(3);
        order.touch(1);
        assert_eq!(order.pop_oldest(), Some(2));
        order.remove(3);
        assert_eq!(order.pop_oldest(), Some(1));
        assert_eq!(order.pop_oldest(), None);
    }
}
