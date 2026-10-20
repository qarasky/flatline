use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rand::Rng;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::AppState;

/// Prefix for tokens minted here; matches the old `uk` keys' spirit while
/// being obviously a Flatline credential.
///
/// Imported Node keys are `uk<id>_<secret>`, so a `flatline_` token can only
/// ever be a sha256 token: [`verify_token`] never runs bcrypt for one.
pub const TOKEN_PREFIX: &str = "flatline_";

/// How long a verified imported (bcrypt) key skips bcrypt. The row is still
/// re-read on every request, so revocation and expiry apply immediately;
/// the TTL only bounds how long a cached hash match is trusted.
const VERIFIED_TTL: Duration = Duration::from_secs(10 * 60);
const VERIFIED_CAP: usize = 256;
/// How long a token that failed every bcrypt check is rejected without
/// running bcrypt again.
const REJECTED_TTL: Duration = Duration::from_secs(60);
const REJECTED_CAP: usize = 4096;
/// Failed bcrypt verifications allowed per window, instance-wide, before
/// further uncached non-`flatline_` tokens are answered 429.
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const FAILURE_BUDGET: u32 = 30;
/// Concurrent bcrypt verifications; each one costs tens of milliseconds of
/// CPU, so a burst must not take every blocking thread.
const BCRYPT_CONCURRENCY: usize = 2;
/// `last_used_at` is written at most this often per token.
const TOUCH_INTERVAL: Duration = Duration::from_secs(60);
const TOUCH_CAP: usize = 4096;

/// Why a token could not be checked. Distinct from "invalid": callers must
/// not sign a client out because the database was busy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The token store could not be read (database error, pool closed, a
    /// failed verification worker).
    Unavailable(String),
    /// Too many failed imported-key checks recently; retry later.
    Throttled,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(f, "token store unavailable: {reason}"),
            Self::Throttled => write!(f, "too many failed token checks"),
        }
    }
}

impl From<sqlx::Error> for VerifyError {
    fn from(error: sqlx::Error) -> Self {
        Self::Unavailable(error.to_string())
    }
}

/// A small map whose entries expire, bounded so junk input cannot grow it.
struct Expiring<V> {
    entries: HashMap<String, (Instant, V)>,
    ttl: Duration,
    cap: usize,
}

impl<V: Clone> Expiring<V> {
    fn new(ttl: Duration, cap: usize) -> Self {
        Self {
            entries: HashMap::new(),
            ttl,
            cap,
        }
    }

    fn get(&mut self, key: &str) -> Option<V> {
        match self.entries.get(key) {
            Some((at, value)) if at.elapsed() < self.ttl => Some(value.clone()),
            Some(_) => {
                self.entries.remove(key);
                None
            }
            None => None,
        }
    }

    fn insert(&mut self, key: String, value: V) {
        if self.entries.len() >= self.cap && !self.entries.contains_key(&key) {
            let ttl = self.ttl;
            self.entries.retain(|_, (at, _)| at.elapsed() < ttl);
            if self.entries.len() >= self.cap
                && let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (Instant::now(), value));
    }

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
    }
}

/// Fixed-window counter of failed bcrypt verifications.
struct FailureLimiter {
    window_start: Instant,
    failures: u32,
    window: Duration,
    budget: u32,
}

impl FailureLimiter {
    fn new(window: Duration, budget: u32) -> Self {
        Self {
            window_start: Instant::now(),
            failures: 0,
            window,
            budget,
        }
    }

    fn roll(&mut self, now: Instant) {
        if now.duration_since(self.window_start) >= self.window {
            self.window_start = now;
            self.failures = 0;
        }
    }

    fn exhausted(&mut self, now: Instant) -> bool {
        self.roll(now);
        self.failures >= self.budget
    }

    fn record_failure(&mut self, now: Instant) {
        self.roll(now);
        self.failures = self.failures.saturating_add(1);
    }
}

/// sha256(token) -> the bcrypt hash it verified against.
static VERIFIED: LazyLock<Mutex<Expiring<String>>> =
    LazyLock::new(|| Mutex::new(Expiring::new(VERIFIED_TTL, VERIFIED_CAP)));
/// sha256(token) of tokens that recently failed every bcrypt check.
static REJECTED: LazyLock<Mutex<Expiring<()>>> =
    LazyLock::new(|| Mutex::new(Expiring::new(REJECTED_TTL, REJECTED_CAP)));
static FAILURES: LazyLock<Mutex<FailureLimiter>> =
    LazyLock::new(|| Mutex::new(FailureLimiter::new(FAILURE_WINDOW, FAILURE_BUDGET)));
static BCRYPT_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(BCRYPT_CONCURRENCY));
/// sha256(token) -> last `last_used_at` write.
static TOUCHED: LazyLock<Mutex<Expiring<()>>> =
    LazyLock::new(|| Mutex::new(Expiring::new(TOUCH_INTERVAL, TOUCH_CAP)));

/// SHA-256 hex of a token. New tokens are stored hashed: the plaintext
/// exists only in the operator's hands.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Mint a fresh token: 20 random bytes, hex encoded.
pub fn mint_token() -> String {
    let mut bytes = [0u8; 20];
    rand::rng().fill_bytes(&mut bytes);
    format!("{TOKEN_PREFIX}{}", hex::encode(bytes))
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: i64,
    hash: String,
    active: i64,
    expires: Option<String>,
}

/// A token is usable while it is active and not expired. An unparseable
/// expiry is ignored, like the Node `dayjs` check.
fn token_valid(row: &TokenRow) -> bool {
    if row.active == 0 {
        return false;
    }
    if let Some(expires) = &row.expires
        && let Some(at) = crate::metrics::metric_time(expires)
        && at < chrono::Utc::now().timestamp_millis()
    {
        return false;
    }
    true
}

/// Verify a monitor push token.
///
/// Agents carry a push token, not an operator API key, so this doubles as the
/// fleet whitelist for `/agent/*`: only a host already provisioned to report
/// can fetch a binary. The token must belong to an active monitor.
pub async fn verify_push_token(pool: &SqlitePool, token: &str) -> Result<bool, VerifyError> {
    if token.is_empty() {
        return Ok(false);
    }
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM monitors WHERE push_token = ? AND active = 1 LIMIT 1")
            .bind(token)
            .fetch_optional(pool)
            .await?;
    Ok(found.is_some())
}

/// Verify a bearer token against the token table.
///
/// `Ok(false)` means the token is not valid; `Err` means it could not be
/// checked (the database failed, or the failed-check limiter tripped) and
/// says nothing about the token — callers answer 503/429, never 401.
///
/// Two schemes coexist: sha256 for tokens minted here, bcrypt for API keys
/// imported from the Node database — so existing automation keeps working
/// after cutover. Bcrypt is the slow path and is fenced accordingly:
/// `flatline_` tokens never reach it, a verified imported key is cached (its
/// row is still re-read, so revocation and expiry apply at once), a token
/// that just failed is rejected from a short negative cache, verification
/// runs on the blocking pool behind a small semaphore, and failed checks are
/// budgeted instance-wide.
pub async fn verify_token(pool: &SqlitePool, token: &str) -> Result<bool, VerifyError> {
    if token.is_empty() {
        return Ok(false);
    }

    let digest = hash_token(token);
    let found: Option<TokenRow> = sqlx::query_as(
        "SELECT id, hash, active, expires FROM tokens WHERE hash = ? AND scheme = 'sha256'",
    )
    .bind(&digest)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = found {
        if !token_valid(&row) {
            return Ok(false);
        }
        touch(pool, &digest, row.id);
        return Ok(true);
    }

    // Minted tokens are sha256-only; a miss is final.
    if token.starts_with(TOKEN_PREFIX) {
        return Ok(false);
    }

    // A recently verified imported key: re-read its row by the hash it
    // matched, so a revoked, expired or deleted key stops working at once.
    let cached_hash = VERIFIED.lock().unwrap().get(&digest);
    if let Some(bcrypt_hash) = cached_hash {
        let row: Option<TokenRow> = sqlx::query_as(
            "SELECT id, hash, active, expires FROM tokens WHERE scheme = 'bcrypt' AND hash = ?",
        )
        .bind(&bcrypt_hash)
        .fetch_optional(pool)
        .await?;
        match row {
            Some(row) => {
                if !token_valid(&row) {
                    return Ok(false);
                }
                touch(pool, &digest, row.id);
                return Ok(true);
            }
            None => VERIFIED.lock().unwrap().remove(&digest),
        }
    }

    if REJECTED.lock().unwrap().get(&digest).is_some() {
        return Ok(false);
    }

    let imported: Vec<TokenRow> =
        sqlx::query_as("SELECT id, hash, active, expires FROM tokens WHERE scheme = 'bcrypt'")
            .fetch_all(pool)
            .await?;
    let candidates: Vec<(i64, String)> = imported
        .into_iter()
        .filter(token_valid)
        .map(|row| (row.id, row.hash))
        .collect();
    if candidates.is_empty() {
        return Ok(false);
    }

    if FAILURES.lock().unwrap().exhausted(Instant::now()) {
        return Err(VerifyError::Throttled);
    }

    let matched = {
        let _slot = BCRYPT_SLOTS
            .acquire()
            .await
            .map_err(|error| VerifyError::Unavailable(error.to_string()))?;
        let plaintext = token.to_string();
        tokio::task::spawn_blocking(move || {
            candidates
                .into_iter()
                .find(|(_, hash)| bcrypt::verify(&plaintext, hash).unwrap_or(false))
        })
        .await
        .map_err(|error| VerifyError::Unavailable(error.to_string()))?
    };

    match matched {
        Some((id, hash)) => {
            VERIFIED.lock().unwrap().insert(digest.clone(), hash);
            touch(pool, &digest, id);
            Ok(true)
        }
        None => {
            FAILURES.lock().unwrap().record_failure(Instant::now());
            REJECTED.lock().unwrap().insert(digest, ());
            Ok(false)
        }
    }
}

/// Whether a revalidation result means the token was revoked. A store error
/// is not a revocation: the SSE stream skips that round instead of telling
/// the dashboard to sign out.
pub fn is_revoked(result: &Result<bool, VerifyError>) -> bool {
    matches!(result, Ok(false))
}

/// Record last use, at most once per [`TOUCH_INTERVAL`] per token and off
/// the request path; failures are ignored — this is observability, not auth.
fn touch(pool: &SqlitePool, digest: &str, id: i64) {
    {
        let mut touched = TOUCHED.lock().unwrap();
        if touched.get(digest).is_some() {
            return;
        }
        touched.insert(digest.to_string(), ());
    }
    let pool = pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE tokens SET last_used_at = strftime('%Y-%m-%d %H:%M:%S', 'now') WHERE id = ?",
        )
        .bind(id)
        .execute(&pool)
        .await;
    });
}

/// On a fresh database, mint the admin token and store it in the data
/// directory (0600). Returns the plaintext once so boot can log it.
pub async fn ensure_initial_token(
    pool: &SqlitePool,
    data_dir: &Path,
) -> anyhow::Result<Option<String>> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tokens")
        .fetch_one(pool)
        .await?;

    if count > 0 {
        return Ok(None);
    }

    let token = mint_token();
    sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('admin', ?, 'sha256')")
        .bind(hash_token(&token))
        .execute(pool)
        .await?;

    write_token_file(&data_dir.join("initial-token.txt"), &token)?;
    Ok(Some(token))
}

/// Mint an admin token unconditionally. Used by the importer: the operator
/// must be able to sign in even when every imported key's plaintext is lost.
pub async fn mint_admin_token(pool: &SqlitePool, data_dir: &Path) -> anyhow::Result<String> {
    let token = mint_token();
    sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('admin', ?, 'sha256')")
        .bind(hash_token(&token))
        .execute(pool)
        .await?;

    write_token_file(&data_dir.join("initial-token.txt"), &token)?;
    Ok(token)
}

/// Write the token file with owner-only permissions.
fn write_token_file(path: &Path, token: &str) -> anyhow::Result<()> {
    std::fs::write(path, format!("{token}\n"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

/// The bearer token of a request, if any.
pub fn bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// Middleware: every `/api/v1` route requires a valid bearer token.
/// The push endpoint authenticates by monitor token in the path instead and
/// is mounted separately.
///
/// 401 only for a token that is missing or invalid; a token store failure
/// answers 503 and the failed-check limiter 429, so a busy database never
/// signs a client out.
pub async fn require_token(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(token) = bearer(request.headers()) else {
        return unauthorized();
    };
    match verify_token(&state.pool, token).await {
        Ok(true) => next.run(request).await,
        Ok(false) => unauthorized(),
        Err(error) => verify_error_response(&error),
    }
}

/// The response for a token that could not be checked.
pub fn verify_error_response(error: &VerifyError) -> Response {
    match error {
        VerifyError::Unavailable(reason) => {
            tracing::warn!("auth: token store unavailable: {reason}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, "5")],
                Json(json!({
                    "ok": false,
                    "error": "unavailable",
                    "message": "The token could not be checked right now; retry shortly.",
                })),
            )
                .into_response()
        }
        VerifyError::Throttled => (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "60")],
            Json(json!({
                "ok": false,
                "error": "rate_limited",
                "message": "Too many failed sign-in attempts; retry in a minute.",
            })),
        )
            .into_response(),
    }
}

/// JSON 401, matching the Node backend's error envelope.
pub fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "unauthorized",
            "message": "Missing or invalid token.",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let dir = tempfile::tempdir().unwrap();
        // Leak the tempdir: the pool outlives this scope in tests.
        let path = dir.keep();
        crate::db::connect(&path).await.unwrap()
    }

    async fn insert_bcrypt(pool: &SqlitePool, plaintext: &str) -> i64 {
        let bcrypt_hash = bcrypt::hash(plaintext, 4).unwrap();
        sqlx::query_scalar(
            "INSERT INTO tokens (name, hash, scheme) VALUES ('imported', ?, 'bcrypt') RETURNING id",
        )
        .bind(&bcrypt_hash)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn minted_tokens_are_hashed_and_verifiable() {
        let pool = test_pool().await;
        let token = mint_token();
        assert!(token.starts_with(TOKEN_PREFIX));

        sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('t', ?, 'sha256')")
            .bind(hash_token(&token))
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(verify_token(&pool, &token).await, Ok(true));
        assert_eq!(verify_token(&pool, "flatline_wrong").await, Ok(false));
        assert_eq!(verify_token(&pool, "").await, Ok(false));

        // The stored row is a hash, not the token.
        let stored: String = sqlx::query_scalar("SELECT hash FROM tokens")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_ne!(stored, token);
        assert_eq!(stored, hash_token(&token));
    }

    #[tokio::test]
    async fn imported_bcrypt_keys_still_verify() {
        let pool = test_pool().await;
        insert_bcrypt(&pool, "uk7_supersecret").await;

        assert_eq!(
            verify_token(&pool, "uk7_supersecret").await,
            Ok(true),
            "imported keys must keep working"
        );
        assert_eq!(verify_token(&pool, "uk7_wrong").await, Ok(false));
    }

    #[tokio::test]
    async fn store_errors_are_not_invalid_tokens() {
        let pool = test_pool().await;
        pool.close().await;
        let result = verify_token(&pool, "flatline_anything").await;
        assert!(
            matches!(result, Err(VerifyError::Unavailable(_))),
            "a closed pool must surface as an error, got {result:?}"
        );
        // The SSE revalidation keeps the stream open on such a round.
        assert!(!is_revoked(&result));
        assert!(is_revoked(&Ok(false)));
        assert!(!is_revoked(&Ok(true)));
        assert!(matches!(
            verify_push_token(&pool, "anything").await,
            Err(VerifyError::Unavailable(_))
        ));
    }

    #[tokio::test]
    async fn flatline_tokens_never_reach_bcrypt() {
        let pool = test_pool().await;
        // A bcrypt row whose plaintext carries the minted prefix: were the
        // prefix not short-circuited, this would verify.
        insert_bcrypt(&pool, "flatline_imported_lookalike").await;
        assert_eq!(
            verify_token(&pool, "flatline_imported_lookalike").await,
            Ok(false),
            "a flatline_ token is sha256-only"
        );
    }

    #[tokio::test]
    async fn verified_imported_keys_are_cached_and_revocation_still_applies() {
        let pool = test_pool().await;
        let plaintext = "uk42_cache_me";
        let id = insert_bcrypt(&pool, plaintext).await;
        let digest = hash_token(plaintext);

        assert_eq!(verify_token(&pool, plaintext).await, Ok(true));
        assert!(
            VERIFIED.lock().unwrap().get(&digest).is_some(),
            "a verified imported key is cached"
        );

        // Prove the skip: seed the cache with a row whose hash bcrypt would
        // reject for this plaintext. Only the cached path can accept it.
        let seeded_plain = "uk43_seeded";
        let decoy = bcrypt::hash("uk43_something_else", 4).unwrap();
        sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('decoy', ?, 'bcrypt')")
            .bind(&decoy)
            .execute(&pool)
            .await
            .unwrap();
        VERIFIED
            .lock()
            .unwrap()
            .insert(hash_token(seeded_plain), decoy);
        assert_eq!(
            verify_token(&pool, seeded_plain).await,
            Ok(true),
            "a cached key is accepted without bcrypt"
        );

        // Expiry and deactivation are honoured on the cached path.
        sqlx::query("UPDATE tokens SET expires = '2000-01-01 00:00:00' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(verify_token(&pool, plaintext).await, Ok(false));
        sqlx::query("UPDATE tokens SET expires = NULL, active = 0 WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(verify_token(&pool, plaintext).await, Ok(false));

        // A deleted key drops out of the cache.
        sqlx::query("DELETE FROM tokens WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(verify_token(&pool, plaintext).await, Ok(false));
        assert!(VERIFIED.lock().unwrap().get(&digest).is_none());
    }

    #[tokio::test]
    async fn rejected_tokens_skip_bcrypt_for_a_while() {
        let pool = test_pool().await;
        insert_bcrypt(&pool, "uk5_real").await;
        assert_eq!(verify_token(&pool, "uk5_junk_rejected").await, Ok(false));
        assert!(
            REJECTED
                .lock()
                .unwrap()
                .get(&hash_token("uk5_junk_rejected"))
                .is_some()
        );
    }

    #[test]
    fn failure_limiter_trips_and_resets() {
        let mut limiter = FailureLimiter::new(Duration::from_secs(60), 3);
        let start = Instant::now();
        for _ in 0..3 {
            assert!(!limiter.exhausted(start));
            limiter.record_failure(start);
        }
        assert!(limiter.exhausted(start + Duration::from_secs(1)));
        // A new window starts the budget over.
        assert!(!limiter.exhausted(start + Duration::from_secs(61)));
    }

    #[test]
    fn expiring_map_is_bounded() {
        let mut map: Expiring<()> = Expiring::new(Duration::from_secs(60), 3);
        for key in ["a", "b", "c", "d"] {
            map.insert(key.to_string(), ());
        }
        assert_eq!(map.entries.len(), 3);
        assert!(map.get("d").is_some(), "the newest entry is kept");

        let mut short: Expiring<()> = Expiring::new(Duration::from_millis(0), 8);
        short.insert("x".to_string(), ());
        assert!(short.get("x").is_none(), "expired entries are not served");
    }

    #[tokio::test]
    async fn last_use_is_written_at_most_once_per_interval() {
        let pool = test_pool().await;
        let token = mint_token();
        sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('t', ?, 'sha256')")
            .bind(hash_token(&token))
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(verify_token(&pool, &token).await, Ok(true));
        assert!(TOUCHED.lock().unwrap().get(&hash_token(&token)).is_some());

        // Clear the column; a second verification inside the interval must
        // not write it again.
        tokio::time::sleep(Duration::from_millis(50)).await;
        sqlx::query("UPDATE tokens SET last_used_at = NULL")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(verify_token(&pool, &token).await, Ok(true));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let last: Option<String> = sqlx::query_scalar("SELECT last_used_at FROM tokens")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(last.is_none(), "touch is throttled");
    }

    #[tokio::test]
    async fn initial_token_is_written_once() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::connect(dir.path()).await.unwrap();

        let first = ensure_initial_token(&pool, dir.path()).await.unwrap();
        assert!(first.is_some());
        assert!(dir.path().join("initial-token.txt").exists());

        // Second call is a no-op: never rotate silently.
        let second = ensure_initial_token(&pool, dir.path()).await.unwrap();
        assert!(second.is_none());

        assert_eq!(verify_token(&pool, &first.unwrap()).await, Ok(true));
    }

    #[tokio::test]
    async fn push_tokens_are_the_agent_whitelist() {
        let pool = test_pool().await;
        for (name, active, token) in [
            ("edge-01", 1, "mocksb-edge-01"),
            ("retired", 0, "inactive-token"),
        ] {
            sqlx::query(
                "INSERT INTO monitors (name, type, active, push_token) VALUES (?, 'push', ?, ?)",
            )
            .bind(name)
            .bind(active)
            .bind(token)
            .execute(&pool)
            .await
            .unwrap();
        }

        assert_eq!(verify_push_token(&pool, "mocksb-edge-01").await, Ok(true));
        // An inactive monitor must not hand out binaries.
        assert_eq!(verify_push_token(&pool, "inactive-token").await, Ok(false));
        assert_eq!(verify_push_token(&pool, "nope").await, Ok(false));
        assert_eq!(verify_push_token(&pool, "").await, Ok(false));
        // An operator API key is not a push token: the two credentials stay
        // distinguishable even though both unlock `/agent/*`.
        assert_eq!(
            verify_push_token(&pool, "flatline_deadbeef").await,
            Ok(false)
        );
    }
}
