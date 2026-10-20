//! Short-lived response cache for the public read surfaces (status pages
//! and badges).
//!
//! These endpoints are polled by every open status page, wall screen and
//! README badge; without a cache each poll ran its queries afresh against
//! the five-connection pool (A3). Values are cached for [`PUBLIC_TTL`] — well
//! inside a status page's 30-second refresh — and only *data* is cached:
//! the published/password gate runs on every request, so locking or
//! unpublishing a page takes effect immediately.
//!
//! Keys are namespaced by the instance's data directory so two instances
//! in one process (the integration tests) never share entries.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::AppState;

/// How long a public response stays cached.
pub const PUBLIC_TTL: Duration = Duration::from_secs(10);

/// A bounded TTL map. Misses compute outside the lock; two concurrent
/// misses may both compute, which is harmless for read-only data.
pub struct ResponseCache<V> {
    entries: Mutex<HashMap<String, (Instant, V)>>,
    ttl: Duration,
    cap: usize,
}

impl<V: Clone> ResponseCache<V> {
    pub fn new(ttl: Duration, cap: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl,
            cap,
        }
    }

    pub fn get(&self, key: &str) -> Option<V> {
        let entries = self.entries.lock().unwrap();
        entries
            .get(key)
            .filter(|(at, _)| at.elapsed() < self.ttl)
            .map(|(_, value)| value.clone())
    }

    pub fn insert(&self, key: String, value: V) {
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= self.cap && !entries.contains_key(&key) {
            let ttl = self.ttl;
            entries.retain(|_, (at, _)| at.elapsed() < ttl);
            if entries.len() >= self.cap {
                // Still full of live entries: start over rather than scan
                // for the oldest on every insert under a flood.
                entries.clear();
            }
        }
        entries.insert(key, (Instant::now(), value));
    }

    /// The cached value, or `compute()` cached on success. Errors are not
    /// cached.
    pub async fn get_or_try<E, F, Fut>(&self, key: String, compute: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        if let Some(value) = self.get(&key) {
            return Ok(value);
        }
        let value = compute().await?;
        self.insert(key, value.clone());
        Ok(value)
    }
}

/// A cache key scoped to this instance.
pub fn key(state: &AppState, parts: &str) -> String {
    format!("{}|{parts}", state.config.data_dir.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn caches_values_but_not_errors() {
        let cache: ResponseCache<i64> = ResponseCache::new(Duration::from_secs(60), 4);
        let first: Result<i64, ()> = cache.get_or_try("a".into(), || async { Ok(1) }).await;
        assert_eq!(first, Ok(1));
        let second: Result<i64, ()> = cache.get_or_try("a".into(), || async { Ok(2) }).await;
        assert_eq!(second, Ok(1), "served from cache");

        let failed: Result<i64, &str> = cache.get_or_try("b".into(), || async { Err("db") }).await;
        assert_eq!(failed, Err("db"));
        assert!(cache.get("b").is_none(), "errors are not cached");
    }

    #[test]
    fn entries_expire_and_the_map_is_bounded() {
        let cache: ResponseCache<i64> = ResponseCache::new(Duration::ZERO, 2);
        cache.insert("a".into(), 1);
        assert!(cache.get("a").is_none(), "expired");

        let cache: ResponseCache<i64> = ResponseCache::new(Duration::from_secs(60), 2);
        for (index, key) in ["a", "b", "c"].iter().enumerate() {
            cache.insert(key.to_string(), index as i64);
        }
        assert!(cache.entries.lock().unwrap().len() <= 2);
        assert_eq!(cache.get("c"), Some(2));
    }
}
