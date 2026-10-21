//! `GET /api/v1/monitors/heartbeat-strips`: per-monitor status strips.
//!
//! Each strip is `buckets` fixed-width time buckets, oldest first, ending
//! with the bucket that contains "now". Buckets are aligned to multiples of
//! `bucketSeconds` since the Unix epoch, so a client can place a live beat
//! without asking. A bucket is `[worstStatus, beats, failedBeats]`, or
//! `null` when it holds no heartbeat rows.
//!
//! Cost: one bounded range scan per monitor on `(monitor_id, time)`,
//! aggregated in SQL, run with small bounded concurrency so the 5-connection
//! pool is never monopolised. Results are cached for a few seconds per
//! (monitor, hours, buckets, current bucket) so dashboards polling together
//! do not multiply the work; the bucket index in the key means a strip is
//! never served across a bucket boundary.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::extract::{Query, State};
use chrono::DateTime;
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

use crate::AppState;
use crate::api::ApiError;
use crate::heartbeats::{DOWN, MAINTENANCE, PENDING, UP};

/// Most monitors one request may cover.
pub const MAX_IDS: usize = 200;
pub const MAX_HOURS: u32 = 168;
pub const MAX_BUCKETS: u32 = 120;
pub const DEFAULT_HOURS: u32 = 24;
pub const DEFAULT_BUCKETS: u32 = 48;
/// Narrowest bucket allowed, in seconds.
pub const MIN_BUCKET_SECONDS: u32 = 60;
/// How long a computed strip is reused, in milliseconds.
pub const CACHE_TTL_MS: i64 = 10_000;
/// Entries kept before the cache is swept.
pub const CACHE_CAPACITY: usize = 4096;
/// Monitor queries in flight at once (the pool holds 5 connections).
const CONCURRENCY: usize = 4;

/// `[worstStatus, beats, failedBeats]`.
pub type Bucket = [i64; 3];
/// `buckets` entries, oldest first.
pub type Strip = Vec<Option<Bucket>>;

/// Validated request shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub hours: u32,
    pub buckets: u32,
    pub bucket_seconds: i64,
}

impl Window {
    pub fn new(hours: u32, buckets: u32) -> Result<Self, String> {
        if !(1..=MAX_HOURS).contains(&hours) {
            return Err(format!("`hours` must be an integer from 1 to {MAX_HOURS}."));
        }
        if !(1..=MAX_BUCKETS).contains(&buckets) {
            return Err(format!(
                "`buckets` must be an integer from 1 to {MAX_BUCKETS}."
            ));
        }
        let total = i64::from(hours) * 3600;
        if total % i64::from(buckets) != 0 {
            return Err(format!(
                "`hours` * 3600 must divide evenly by `buckets` ({hours} h in {buckets} buckets is not a whole number of seconds)."
            ));
        }
        let bucket_seconds = total / i64::from(buckets);
        if bucket_seconds < i64::from(MIN_BUCKET_SECONDS) {
            return Err(format!(
                "Buckets must be at least {MIN_BUCKET_SECONDS} seconds wide ({hours} h in {buckets} buckets gives {bucket_seconds} s)."
            ));
        }
        Ok(Self {
            hours,
            buckets,
            bucket_seconds,
        })
    }

    /// Index (since the epoch) of the bucket containing `now_ms`.
    pub fn last_index(&self, now_ms: i64) -> i64 {
        now_ms.div_euclid(1000).div_euclid(self.bucket_seconds)
    }

    /// Index of the oldest bucket.
    pub fn first_index(&self, now_ms: i64) -> i64 {
        self.last_index(now_ms) - i64::from(self.buckets) + 1
    }

    /// Start of the first bucket, epoch milliseconds.
    pub fn start_ms(&self, now_ms: i64) -> i64 {
        self.first_index(now_ms) * self.bucket_seconds * 1000
    }
}

/// Cache key; the current bucket index keeps a strip from outliving its
/// bucket boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    pub monitor_id: i64,
    pub hours: u32,
    pub buckets: u32,
    pub last_index: i64,
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Small bounded TTL cache of computed strips, with an injectable clock
/// (epoch milliseconds).
pub struct StripCache {
    entries: Mutex<HashMap<Key, (i64, Arc<Strip>)>>,
    ttl_ms: i64,
    capacity: usize,
    clock: Clock,
}

impl Default for StripCache {
    fn default() -> Self {
        Self::new()
    }
}

impl StripCache {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(|| chrono::Utc::now().timestamp_millis()))
    }

    pub fn with_clock(clock: Clock) -> Self {
        Self::with_limits(clock, CACHE_TTL_MS, CACHE_CAPACITY)
    }

    pub fn with_limits(clock: Clock, ttl_ms: i64, capacity: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl_ms,
            capacity: capacity.max(1),
            clock,
        }
    }

    pub fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    pub fn get(&self, key: &Key, now_ms: i64) -> Option<Arc<Strip>> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let (stored, strip) = entries.get(key)?;
        // A clock stepped backwards makes the entry untrustworthy.
        (now_ms >= *stored && now_ms - *stored < self.ttl_ms).then(|| Arc::clone(strip))
    }

    pub fn put(&self, key: Key, strip: Arc<Strip>, now_ms: i64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= self.capacity && !entries.contains_key(&key) {
            let ttl = self.ttl_ms;
            entries.retain(|_, (stored, _)| now_ms >= *stored && now_ms - *stored < ttl);
            if entries.len() >= self.capacity {
                entries.clear();
            }
        }
        entries.insert(key, (now_ms, strip));
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Severity rank used by the SQL aggregate: down > pending > maintenance > up.
fn status_from_rank(rank: i64) -> i64 {
    match rank {
        3 => DOWN,
        2 => PENDING,
        1 => MAINTENANCE,
        _ => UP,
    }
}

/// One bounded range scan for one monitor.
async fn compute(
    pool: &SqlitePool,
    monitor_id: i64,
    window: Window,
    now_ms: i64,
) -> sqlx::Result<Strip> {
    let first = window.first_index(now_ms);
    let last = window.last_index(now_ms);
    // Stored times are `YYYY-MM-DD HH:MM:SS[.mmm]`; bounds without a
    // fraction compare correctly against both forms.
    let fmt = |index: i64| {
        DateTime::from_timestamp(index * window.bucket_seconds, 0)
            .unwrap_or_default()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    };
    let rows: Vec<(Option<i64>, i64, i64, i64)> = sqlx::query_as(
        "SELECT CAST(strftime('%s', time) AS INTEGER) / ?1 AS bucket,
                MAX(CASE status WHEN 0 THEN 3 WHEN 2 THEN 2 WHEN 3 THEN 1 ELSE 0 END),
                COUNT(*),
                COALESCE(SUM(status = 0), 0)
         FROM heartbeats
         WHERE monitor_id = ?2 AND time >= ?3 AND time < ?4
         GROUP BY bucket",
    )
    .bind(window.bucket_seconds)
    .bind(monitor_id)
    .bind(fmt(first))
    .bind(fmt(last + 1))
    .fetch_all(pool)
    .await?;

    let mut strip: Strip = vec![None; window.buckets as usize];
    for (bucket, rank, beats, failed) in rows {
        let Some(index) = bucket.map(|b| b - first) else {
            continue;
        };
        if let Some(slot) = usize::try_from(index).ok().and_then(|i| strip.get_mut(i)) {
            *slot = Some([status_from_rank(rank), beats, failed]);
        }
    }
    Ok(strip)
}

/// Strips for `ids`, from cache where fresh, else computed with at most
/// [`CONCURRENCY`] queries in flight.
async fn strips_for(
    state: &AppState,
    ids: &[i64],
    window: Window,
    now_ms: i64,
) -> Result<Vec<(i64, Arc<Strip>)>, ApiError> {
    let last_index = window.last_index(now_ms);
    let key = |monitor_id| Key {
        monitor_id,
        hours: window.hours,
        buckets: window.buckets,
        last_index,
    };

    let mut out = Vec::with_capacity(ids.len());
    let mut missing = Vec::new();
    for &id in ids {
        match state.strips.get(&key(id), now_ms) {
            Some(strip) => out.push((id, strip)),
            None => missing.push(id),
        }
    }

    let mut lanes: Vec<Vec<i64>> = vec![Vec::new(); CONCURRENCY.min(missing.len())];
    let lane_count = lanes.len();
    for (n, id) in missing.into_iter().enumerate() {
        lanes[n % lane_count].push(id);
    }
    let mut tasks = tokio::task::JoinSet::new();
    for lane in lanes {
        let pool = state.pool.clone();
        tasks.spawn(async move {
            let mut done = Vec::with_capacity(lane.len());
            for id in lane {
                done.push((id, compute(&pool, id, window, now_ms).await?));
            }
            Ok::<_, sqlx::Error>(done)
        });
    }
    while let Some(joined) = tasks.join_next().await {
        let done = joined
            .map_err(|error| {
                tracing::error!("heartbeat strips task: {error}");
                ApiError::server()
            })?
            .map_err(|error| {
                tracing::error!("heartbeat strips: {error}");
                ApiError::server()
            })?;
        for (id, strip) in done {
            let strip = Arc::new(strip);
            state.strips.put(key(id), Arc::clone(&strip), now_ms);
            out.push((id, strip));
        }
    }
    Ok(out)
}

fn parse_count(
    params: &HashMap<String, String>,
    name: &str,
    default: u32,
) -> Result<u32, ApiError> {
    match params.get(name) {
        None => Ok(default),
        Some(raw) => raw
            .trim()
            .parse::<u32>()
            .map_err(|_| ApiError::bad(format!("`{name}` must be a positive integer."))),
    }
}

fn parse_ids(raw: &str) -> Result<Vec<i64>, ApiError> {
    let parts: Vec<&str> = raw.split(',').map(str::trim).collect();
    if parts.len() > MAX_IDS {
        return Err(ApiError::bad(format!(
            "`ids` may list at most {MAX_IDS} monitor ids."
        )));
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::with_capacity(parts.len());
    for part in parts {
        let id = part
            .chars()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse::<i64>().ok())
            .flatten()
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                ApiError::bad(
                    "`ids` must be a comma-separated list of positive integers, e.g. ?ids=4,5,6 (max 200). Omit `ids` for all monitors.",
                )
            })?;
        if seen.insert(id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// GET /api/v1/monitors/heartbeat-strips?ids=1,2,3&hours=24&buckets=48
pub async fn strips(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let hours = parse_count(&params, "hours", DEFAULT_HOURS)?;
    let buckets = parse_count(&params, "buckets", DEFAULT_BUCKETS)?;
    let window = Window::new(hours, buckets).map_err(ApiError::bad)?;
    let requested = params.get("ids").map(|raw| parse_ids(raw)).transpose()?;

    let internal = |error: sqlx::Error| {
        tracing::error!("heartbeat strips: {error}");
        ApiError::server()
    };
    let ids: Vec<i64> = match requested {
        Some(ids) => {
            let placeholders = vec!["?"; ids.len()].join(",");
            let sql = format!("SELECT id FROM monitors WHERE id IN ({placeholders}) ORDER BY id");
            let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
            for id in &ids {
                query = query.bind(id);
            }
            query.fetch_all(&state.pool).await.map_err(internal)?
        }
        None => sqlx::query_scalar("SELECT id FROM monitors ORDER BY id LIMIT ?")
            .bind(MAX_IDS as i64)
            .fetch_all(&state.pool)
            .await
            .map_err(internal)?,
    };

    let now_ms = state.strips.now_ms();
    let computed = strips_for(&state, &ids, window, now_ms).await?;

    let mut map = Map::new();
    for (id, strip) in computed {
        let value: Vec<Value> = strip
            .iter()
            .map(|bucket| bucket.map_or(Value::Null, |b| json!(b)))
            .collect();
        map.insert(id.to_string(), Value::Array(value));
    }
    let start = DateTime::from_timestamp_millis(window.start_ms(now_ms))
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    Ok(Json(json!({
        "ok": true,
        "hours": window.hours,
        "buckets": window.buckets,
        "bucketSeconds": window.bucket_seconds,
        "start": start,
        "strips": map,
    })))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;

    fn key(last_index: i64) -> Key {
        Key {
            monitor_id: 1,
            hours: 24,
            buckets: 48,
            last_index,
        }
    }

    #[test]
    fn window_validation() {
        let w = Window::new(24, 48).unwrap();
        assert_eq!(w.bucket_seconds, 1800);
        assert!(Window::new(0, 48).is_err());
        assert!(Window::new(169, 48).is_err());
        assert!(Window::new(24, 0).is_err());
        assert!(Window::new(24, 121).is_err());
        // 1 h in 7 buckets is not a whole number of seconds.
        assert!(Window::new(1, 7).is_err());
        // 1 h in 120 buckets is 30 s: too narrow.
        assert!(Window::new(1, 120).is_err());
        assert_eq!(Window::new(2, 120).unwrap().bucket_seconds, 60);
        assert_eq!(Window::new(168, 120).unwrap().bucket_seconds, 5040);
    }

    #[test]
    fn buckets_align_to_the_epoch() {
        let w = Window::new(24, 48).unwrap();
        // 2026-10-21T10:47:12Z
        let now = 1_792_579_632_000;
        let last = w.last_index(now);
        assert_eq!(last, now / 1000 / 1800);
        assert_eq!(w.first_index(now), last - 47);
        assert_eq!(w.start_ms(now) % (1800 * 1000), 0);
        // The last bucket contains now; the first starts 47 buckets earlier.
        assert!((last * 1800 * 1000..(last + 1) * 1800 * 1000).contains(&now));
        assert_eq!(w.start_ms(now), (last - 47) * 1_800_000);
        // Exactly on a boundary belongs to the new bucket.
        assert_eq!(w.last_index((last + 1) * 1_800_000), last + 1);
        assert_eq!(w.last_index((last + 1) * 1_800_000 - 1), last);
    }

    #[test]
    fn cache_hits_within_ttl_and_expires() {
        let cache = StripCache::new();
        let strip = Arc::new(vec![None, Some([1, 2, 0])]);
        cache.put(key(5), Arc::clone(&strip), 1_000);
        assert_eq!(cache.get(&key(5), 1_000), Some(Arc::clone(&strip)));
        assert!(cache.get(&key(5), 1_000 + CACHE_TTL_MS - 1).is_some());
        assert!(cache.get(&key(5), 1_000 + CACHE_TTL_MS).is_none());
        // A clock stepped backwards is a miss.
        assert!(cache.get(&key(5), 999).is_none());
    }

    #[test]
    fn cache_never_crosses_a_bucket_boundary() {
        let cache = StripCache::new();
        cache.put(key(5), Arc::new(vec![None]), 1_000);
        // Same instant, next bucket: different key, so no hit.
        assert!(cache.get(&key(6), 1_001).is_none());
    }

    #[test]
    fn cache_is_bounded() {
        let clock = Arc::new(AtomicI64::new(0));
        let c = Arc::clone(&clock);
        let cache = StripCache::with_limits(Arc::new(move || c.load(Ordering::SeqCst)), 10_000, 3);
        for i in 0..10 {
            cache.put(key(i), Arc::new(vec![]), 0);
            assert!(cache.len() <= 3);
        }
        // Expired entries are swept before anything live is dropped.
        let cache = StripCache::with_limits(Arc::new(|| 0), 10, 2);
        cache.put(key(1), Arc::new(vec![]), 0);
        cache.put(key(2), Arc::new(vec![]), 5);
        cache.put(key(3), Arc::new(vec![]), 12);
        assert!(cache.get(&key(2), 12).is_some());
        assert!(cache.get(&key(3), 12).is_some());
        assert!(cache.get(&key(1), 12).is_none());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn cache_uses_the_injected_clock() {
        let clock = Arc::new(AtomicI64::new(42));
        let c = Arc::clone(&clock);
        let cache = StripCache::with_clock(Arc::new(move || c.load(Ordering::SeqCst)));
        assert_eq!(cache.now_ms(), 42);
        clock.store(99, Ordering::SeqCst);
        assert_eq!(cache.now_ms(), 99);
    }

    #[test]
    fn id_parsing() {
        assert_eq!(parse_ids("3, 1,3,2").unwrap(), vec![3, 1, 2]);
        for bad in ["", "1,,2", "a", "-1", "0", "1.5", "1,2,"] {
            assert!(parse_ids(bad).is_err(), "{bad:?}");
        }
        let many = (1..=201)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_ids(&many).is_err());
        let ok = (1..=200)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_ids(&ok).unwrap().len(), 200);
    }
}
