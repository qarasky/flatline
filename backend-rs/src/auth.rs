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

/// Operator tokens: GUI sign-in and every `/api/v1` request. They control the
/// whole instance and are never accepted by agent endpoints.
pub const OP_TOKEN_PREFIX: &str = "flatline_op_";

/// The shared prefix of every agent credential. Push (metric) and backup
/// agents stay separate stores and separate tokens, but both are visibly
/// agent credentials so a human or an AI cannot mistake one for an operator
/// token.
pub const AGENT_TOKEN_PREFIX: &str = "flatline_agent_";

/// A host (metric) agent's push token, stored on its monitor.
pub const PUSH_TOKEN_PREFIX: &str = "flatline_agent_push_";

/// A backup agent's token, stored (hashed) on its `backup_agents` row. This
/// constant mirrors `backups::agents::TOKEN_PREFIX`; both must agree.
pub const BACKUP_TOKEN_PREFIX: &str = "flatline_agent_backup_";

/// The pre-split namespace. Kept so tokens minted before the split keep
/// working; new tokens never use it. Imported Node keys are `uk<id>_<secret>`.
///
/// A legacy `flatline_` token can be either an operator token (row in
/// `tokens`) or a monitor push token, so [`verify_token`] resolves it by
/// store rather than by prefix.
pub const LEGACY_TOKEN_PREFIX: &str = "flatline_";

/// Which kind of bearer credential a string looks like. Prefixes decide the
/// new tokens outright; legacy tokens are resolved against the stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Operator,
    PushAgent,
    BackupAgent,
    /// `flatline_`-prefixed, minted before the split: operator or push
    /// depending on which store holds it.
    Legacy,
    /// Imported `uk<id>_<secret>` key or junk.
    Other,
}

impl TokenKind {
    pub fn is_agent(self) -> bool {
        matches!(self, Self::PushAgent | Self::BackupAgent)
    }

    /// Stable machine name used in API responses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::PushAgent => "push_agent",
            Self::BackupAgent => "backup_agent",
            Self::Legacy => "legacy",
            Self::Other => "unknown",
        }
    }

    /// The prefix this kind of token is minted with.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Operator => OP_TOKEN_PREFIX,
            Self::PushAgent => PUSH_TOKEN_PREFIX,
            Self::BackupAgent => BACKUP_TOKEN_PREFIX,
            Self::Legacy => LEGACY_TOKEN_PREFIX,
            Self::Other => "",
        }
    }
}

/// Classify a token by its prefix alone. No store access.
pub fn token_kind(token: &str) -> TokenKind {
    if token.starts_with(PUSH_TOKEN_PREFIX) {
        TokenKind::PushAgent
    } else if token.starts_with(BACKUP_TOKEN_PREFIX) || token.starts_with("flatline_backup_") {
        TokenKind::BackupAgent
    } else if token.starts_with(OP_TOKEN_PREFIX) {
        TokenKind::Operator
    } else if token.starts_with(LEGACY_TOKEN_PREFIX) {
        TokenKind::Legacy
    } else {
        TokenKind::Other
    }
}

/// The verdict of verifying a bearer token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenVerdict {
    /// A valid operator token (its row id): GUI sign-in and the operator API.
    Operator(i64),
    /// A credential belonging to an agent store. It is not valid for the
    /// operator API or GUI sign-in; handlers answer with an explicit
    /// "agent token" error instead of a bare 401.
    Agent(TokenKind),
    /// Not a credential of any kind.
    Invalid,
}

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

/// Mint a fresh operator token: `flatline_op_` + 20 random bytes, hex encoded.
pub fn mint_op_token() -> String {
    mint_with_prefix(OP_TOKEN_PREFIX)
}

/// Mint a fresh host-agent push token.
pub fn mint_push_token() -> String {
    mint_with_prefix(PUSH_TOKEN_PREFIX)
}

fn mint_with_prefix(prefix: &str) -> String {
    let mut bytes = [0u8; 20];
    rand::rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
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
    token_usable(row.active, row.expires.as_deref())
}

/// The token rule on its columns: active and not past `expires`. Shared with
/// token sessions, which stop when their token does.
pub(crate) fn token_usable(active: i64, expires: Option<&str>) -> bool {
    if active == 0 {
        return false;
    }
    if let Some(expires) = expires
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

/// Verify a bearer token for operator use (GUI sign-in and `/api/v1`).
///
/// Returns [`TokenVerdict::Agent`] when the token belongs to a push or backup
/// agent store, so the caller can say *which* kind of credential was used
/// instead of a bare 401. `Err` means the store could not be checked (the
/// database failed, or the failed-check limiter tripped) and says nothing
/// about the token — callers answer 503/429, never 401.
///
/// Two schemes coexist: sha256 for tokens minted here, bcrypt for API keys
/// imported from the Node database — so existing automation keeps working
/// after cutover. Bcrypt is the slow path and is fenced accordingly:
/// `flatline_`/`flatline_op_`/`flatline_agent_` tokens never reach it, a
/// verified imported key is cached (its row is still re-read, so revocation
/// and expiry apply at once), a token that just failed is rejected from a
/// short negative cache, verification runs on the blocking pool behind a
/// small semaphore, and failed checks are budgeted instance-wide.
///
/// Legacy `flatline_` tokens are resolved by store, not prefix: an operator
/// row in `tokens` wins, then a monitor push token, then a backup-agent hash.
pub async fn verify_token(pool: &SqlitePool, token: &str) -> Result<TokenVerdict, VerifyError> {
    if token.is_empty() {
        return Ok(TokenVerdict::Invalid);
    }

    let kind = token_kind(token);
    // Prefixes minted after the split are authoritative: an agent-prefixed
    // credential is never an operator token, whether or not it exists.
    if kind.is_agent() {
        return Ok(TokenVerdict::Agent(kind));
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
            return Ok(TokenVerdict::Invalid);
        }
        touch(pool, &digest, row.id);
        return Ok(TokenVerdict::Operator(row.id));
    }

    // Minted tokens are sha256-only; a miss on a post-split operator token is
    // final. A legacy `flatline_` miss may still be an agent credential, and
    // saying so is the whole point of the split.
    if token.starts_with(OP_TOKEN_PREFIX) {
        return Ok(TokenVerdict::Invalid);
    }
    // Pre-split credentials are not all `flatline_`-prefixed: agents
    // installed by the Node-era fleet carry a bare 32-hex token. Resolve any
    // non-operator token against the agent stores before the bcrypt path, so
    // using one for sign-in still names it as an agent token.
    if let Some(kind) = legacy_agent_kind(pool, token).await? {
        return Ok(TokenVerdict::Agent(kind));
    }
    // `flatline_` tokens are sha256-only: a miss is final, never bcrypt.
    if kind == TokenKind::Legacy {
        return Ok(TokenVerdict::Invalid);
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
                    return Ok(TokenVerdict::Invalid);
                }
                touch(pool, &digest, row.id);
                return Ok(TokenVerdict::Operator(row.id));
            }
            None => VERIFIED.lock().unwrap().remove(&digest),
        }
    }

    if REJECTED.lock().unwrap().get(&digest).is_some() {
        return Ok(TokenVerdict::Invalid);
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
        return Ok(TokenVerdict::Invalid);
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
            Ok(TokenVerdict::Operator(id))
        }
        None => {
            FAILURES.lock().unwrap().record_failure(Instant::now());
            REJECTED.lock().unwrap().insert(digest, ());
            Ok(TokenVerdict::Invalid)
        }
    }
}

/// Which agent store holds a legacy `flatline_` token, if any.
///
/// Two indexed lookups on the slow path only (a token that missed the
/// operator table), so a legacy agent token gets a precise error without
/// making the normal operator path pay for it.
pub async fn legacy_agent_kind(
    pool: &SqlitePool,
    token: &str,
) -> Result<Option<TokenKind>, VerifyError> {
    let monitor: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM monitors WHERE push_token = ? LIMIT 1")
            .bind(token)
            .fetch_optional(pool)
            .await?;
    if monitor.is_some() {
        return Ok(Some(TokenKind::PushAgent));
    }

    // Every backup credential ever minted was prefixed (`flatline_backup_`
    // then `flatline_agent_backup_`), so a bare token cannot be one. This
    // also keeps the unindexed token_hash scan off the junk-token path.
    if !token.starts_with(LEGACY_TOKEN_PREFIX) {
        return Ok(None);
    }
    let backup: Option<(String,)> =
        sqlx::query_as("SELECT id FROM backup_agents WHERE token_hash = ? LIMIT 1")
            .bind(hash_token(token))
            .fetch_optional(pool)
            .await?;
    Ok(backup.map(|_| TokenKind::BackupAgent))
}

/// Whether the token is a known operator token (sha256 row only).
///
/// Used by agent endpoints to explain a wrong credential kind without
/// running bcrypt: an operator token presented as an agent credential gets
/// "this is an operator token", not "invalid".
pub async fn known_operator_token(pool: &SqlitePool, token: &str) -> Result<bool, VerifyError> {
    if token.is_empty() || token_kind(token).is_agent() {
        return Ok(false);
    }
    let digest = hash_token(token);
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM tokens WHERE hash = ? AND scheme = 'sha256'")
            .bind(&digest)
            .fetch_optional(pool)
            .await?;
    Ok(found.is_some() || token.starts_with(OP_TOKEN_PREFIX))
}

/// Whether a revalidation result means the token was revoked. A store error
/// is not a revocation: the SSE stream skips that round instead of telling
/// the dashboard to sign out.
pub fn is_revoked(result: &Result<TokenVerdict, VerifyError>) -> bool {
    matches!(result, Ok(TokenVerdict::Invalid))
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

    let token = mint_op_token();
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
    let token = mint_op_token();
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

/// The web app's session cookie. It carries a session id (see
/// [`crate::sessions`]), never a token.
pub const SESSION_COOKIE: &str = "fl_session";

/// Header a cookie-authenticated write must carry (value `1`). A page on
/// another site cannot add a custom header to a same-site request without
/// a CORS preflight, which this API never grants.
pub const CSRF_HEADER: &str = "x-flatline-csrf";

/// Session cookie lifetime: 400 days, the most browsers allow. The server
/// ends an idle session sooner (30 days for an account).
pub const SESSION_MAX_AGE: i64 = 34_560_000;

/// Who a request acts as. Every principal has full permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    /// A member signed in with email and password.
    Account {
        user_id: i64,
        must_change_password: bool,
    },
    /// An operator token, as a bearer header or through a token session.
    Token { token_id: i64 },
}

/// The credential a request presented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// `Authorization: Bearer <token>`.
    Bearer(String),
    /// The `fl_session` cookie's session id.
    Session(String),
}

impl Credential {
    /// A stable, non-secret key for per-credential limits (the SSE stream cap).
    pub fn stream_key(&self) -> String {
        match self {
            Credential::Bearer(raw) | Credential::Session(raw) => hash_token(raw),
        }
    }
}

/// The authenticated caller, inserted by [`require_token`] for handlers that
/// need to know who it is.
#[derive(Debug, Clone)]
pub struct Authed {
    pub principal: Principal,
    pub credential: Credential,
}

/// Whether a credential still authenticates: the SSE stream's periodic
/// revalidation. A store error is `Err`, not a revocation.
pub async fn still_valid(pool: &SqlitePool, credential: &Credential) -> Result<bool, VerifyError> {
    match credential {
        Credential::Bearer(token) => Ok(matches!(
            verify_token(pool, token).await?,
            TokenVerdict::Operator(_)
        )),
        Credential::Session(raw) => Ok(crate::sessions::resolve(pool, raw).await?.is_some()),
    }
}

/// The session cookie's value, if the request carries one.
pub fn session_id(headers: &axum::http::HeaderMap) -> Option<String> {
    crate::status_pages::parse_cookies(headers)
        .remove(SESSION_COOKIE)
        .filter(|value| !value.is_empty())
}

/// Whether the request reached the proxy in front over HTTPS.
pub fn request_is_https(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
}

/// The `Set-Cookie` value that signs a browser in with a session id.
pub fn session_cookie(session: &str, secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}={session}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The `Set-Cookie` value that signs a browser out.
pub fn clear_session_cookie(secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

/// Middleware: every `/api/v1` route requires an operator credential: a
/// bearer token, or the web app's session cookie (an account or token
/// session). The push endpoint authenticates by monitor token in the path
/// instead and is mounted separately.
///
/// 401 only for a credential that is missing or invalid; a store failure
/// answers 503 and the failed-check limiter 429, so a busy database never
/// signs a client out. A cookie-authenticated write without the CSRF header
/// answers 403. The caller is passed on as an [`Authed`] extension.
pub async fn require_token(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let authed = if let Some(token) = bearer(request.headers()) {
        let token = token.to_string();
        match verify_token(&state.pool, &token).await {
            Ok(TokenVerdict::Operator(token_id)) => Authed {
                principal: Principal::Token { token_id },
                credential: Credential::Bearer(token),
            },
            Ok(TokenVerdict::Agent(kind)) => return agent_token_on_operator_api(kind),
            Ok(TokenVerdict::Invalid) => return unauthorized(),
            Err(error) => return verify_error_response(&error),
        }
    } else if let Some(session) = session_id(request.headers()) {
        match crate::sessions::resolve(&state.pool, &session).await {
            Ok(Some(principal)) => Authed {
                principal,
                credential: Credential::Session(session),
            },
            Ok(None) => return unauthorized(),
            Err(error) => return verify_error_response(&VerifyError::from(error)),
        }
    } else {
        return unauthorized();
    };

    let safe = matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    );
    let csrf_ok = request
        .headers()
        .get(CSRF_HEADER)
        .is_some_and(|value| value.as_bytes() == b"1");
    if matches!(authed.credential, Credential::Session(_)) && !safe && !csrf_ok {
        return crate::api::ApiError::new(
            StatusCode::FORBIDDEN,
            "csrf_required",
            "Cookie-authenticated writes must send X-Flatline-CSRF: 1.",
        )
        .with_hint(
            "Send the header `X-Flatline-CSRF: 1` with the request, or authenticate with `Authorization: Bearer <token>` instead of the cookie.",
        )
        .into_response();
    }
    request.extensions_mut().insert(authed);
    next.run(request).await
}

/// The response for an agent credential used on the operator API or GUI
/// sign-in. Explicit on purpose: a generic 401 sends humans and AI agents
/// hunting through OpenAPI or source for the difference.
pub fn agent_token_on_operator_api(kind: TokenKind) -> Response {
    let (label, endpoint_hint) = match kind {
        TokenKind::PushAgent => (
            "host-agent token",
            "Push-agent tokens are only accepted by /api/push/{pushToken} and /agent/*. GUI sign-in and /api/v1 need an operator token (`flatline_op_...`); mint one in the dashboard's Agents panel.",
        ),
        TokenKind::BackupAgent => (
            "backup-agent token",
            "Backup-agent tokens are only accepted under /api/backup/v1. GUI sign-in and /api/v1 need an operator token (`flatline_op_...`); mint one in the dashboard's Agents panel.",
        ),
        _ => (
            "agent token",
            "Agent tokens are only accepted by agent endpoints. GUI sign-in and /api/v1 need an operator token (`flatline_op_...`).",
        ),
    };
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "agent_token_on_operator_api",
            "code": "agent_token_on_operator_api",
            "message": format!(
                "This is a {label} (`{}...`), not an operator token.",
                kind.prefix()
            ),
            "tokenKind": kind.as_str(),
            "expectedTokenKind": "operator",
            "expectedPrefix": OP_TOKEN_PREFIX,
            "hint": endpoint_hint,
            "nextActions": [
                "Use an operator token (`flatline_op_...`) for GUI sign-in and /api/v1 requests.",
                "Mint or rotate an operator token in the dashboard: Agents panel -> API keys.",
                "Keep agent tokens in the host agent config; never paste them into a browser login."
            ],
            "docs": "/llms.txt",
        })),
    )
        .into_response()
}

/// The response for an operator credential used on an agent endpoint.
pub fn operator_token_on_agent_api(endpoint: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "operator_token_on_agent_api",
            "code": "operator_token_on_agent_api",
            "message": "This is an operator token, not an agent token.",
            "tokenKind": "operator",
            "expectedTokenKind": "agent",
            "expectedPrefixes": [PUSH_TOKEN_PREFIX, BACKUP_TOKEN_PREFIX],
            "hint": format!(
                "`{endpoint}` authenticates a push or backup agent. Use the host monitor's push token (`flatline_agent_push_...`) or the backup agent's token (`flatline_agent_backup_...`), not an operator token."
            ),
            "docs": "/llms.txt",
        })),
    )
        .into_response()
}

/// The response for a backup-agent credential used on a metric-agent route.
pub fn backup_token_on_metric_agent_api(endpoint: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "backup_agent_token_on_metric_agent_api",
            "code": "backup_agent_token_on_metric_agent_api",
            "message": "This is a backup-agent token, not a host (metric) agent token.",
            "tokenKind": "backup_agent",
            "expectedTokenKind": "push_agent",
            "expectedPrefix": PUSH_TOKEN_PREFIX,
            "hint": format!(
                "`{endpoint}` serves the host telemetry agent. Use the push monitor's token (`flatline_agent_push_...`). Backup agents authenticate under /api/backup/v1 with `flatline_agent_backup_...`."
            ),
            "docs": "/llms.txt",
        })),
    )
        .into_response()
}

/// The response for a push-agent credential used on a backup-agent route.
pub fn push_token_on_backup_agent_api() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "push_agent_token_on_backup_agent_api",
            "code": "push_agent_token_on_backup_agent_api",
            "message": "This is a host (metric) agent token, not a backup-agent token.",
            "tokenKind": "push_agent",
            "expectedTokenKind": "backup_agent",
            "expectedPrefix": BACKUP_TOKEN_PREFIX,
            "hint": "Backup agents authenticate under /api/backup/v1 with their own `flatline_agent_backup_...` credential from the backup-agent registration response. Push monitor tokens only serve /api/push/{pushToken} and /agent/*.",
            "docs": "/llms.txt",
        })),
    )
        .into_response()
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
                    "code": "unavailable",
                    "message": "The token could not be checked right now; retry shortly.",
                    "retryAfterSeconds": 5,
                    "hint": "This is a database problem, not a bad token. Retry the same request after the delay; do not mint a new token.",
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
                "code": "rate_limited",
                "message": "Too many failed sign-in attempts; retry in a minute.",
                "retryAfterSeconds": 60,
                "hint": "The instance-wide budget for failed imported-key checks is exhausted. Wait, then retry. Minted operator tokens are unaffected.",
            })),
        )
            .into_response(),
    }
}

/// JSON 401 for a missing or unknown bearer token.
pub fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "unauthorized",
            "code": "unauthorized",
            "message": "Missing or invalid token.",
            "expectedTokenKind": "operator",
            "expectedPrefix": OP_TOKEN_PREFIX,
            "hint": "Send `Authorization: Bearer flatline_op_...`. Operator tokens sign in to the GUI and authorize /api/v1. Host agents use `flatline_agent_push_...` on /api/push/{token}; backup agents use `flatline_agent_backup_...` on /api/backup/v1.",
            "docs": "/llms.txt",
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
        let token = mint_op_token();
        assert!(token.starts_with(OP_TOKEN_PREFIX));

        sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('t', ?, 'sha256')")
            .bind(hash_token(&token))
            .execute(&pool)
            .await
            .unwrap();

        assert!(
            matches!(
                verify_token(&pool, &token).await,
                Ok(TokenVerdict::Operator(_))
            )
        );
        assert_eq!(
            verify_token(&pool, "flatline_wrong").await,
            Ok(TokenVerdict::Invalid)
        );
        assert_eq!(verify_token(&pool, "").await, Ok(TokenVerdict::Invalid));

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

        assert!(
            matches!(
                verify_token(&pool, "uk7_supersecret").await,
                Ok(TokenVerdict::Operator(_))
            ),
            "imported keys must keep working"
        );
        assert_eq!(
            verify_token(&pool, "uk7_wrong").await,
            Ok(TokenVerdict::Invalid)
        );
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
        assert!(is_revoked(&Ok(TokenVerdict::Invalid)));
        assert!(!is_revoked(&Ok(TokenVerdict::Operator(1))));
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
            Ok(TokenVerdict::Invalid),
            "a flatline_ token is sha256-only"
        );
    }

    #[tokio::test]
    async fn verified_imported_keys_are_cached_and_revocation_still_applies() {
        let pool = test_pool().await;
        let plaintext = "uk42_cache_me";
        let id = insert_bcrypt(&pool, plaintext).await;
        let digest = hash_token(plaintext);

        assert!(
            matches!(
                verify_token(&pool, plaintext).await,
                Ok(TokenVerdict::Operator(_))
            )
        );
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
        assert!(
            matches!(
                verify_token(&pool, seeded_plain).await,
                Ok(TokenVerdict::Operator(_))
            ),
            "a cached key is accepted without bcrypt"
        );

        // Expiry and deactivation are honoured on the cached path.
        sqlx::query("UPDATE tokens SET expires = '2000-01-01 00:00:00' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            verify_token(&pool, plaintext).await,
            Ok(TokenVerdict::Invalid)
        );
        sqlx::query("UPDATE tokens SET expires = NULL, active = 0 WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            verify_token(&pool, plaintext).await,
            Ok(TokenVerdict::Invalid)
        );

        // A deleted key drops out of the cache.
        sqlx::query("DELETE FROM tokens WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            verify_token(&pool, plaintext).await,
            Ok(TokenVerdict::Invalid)
        );
        assert!(VERIFIED.lock().unwrap().get(&digest).is_none());
    }

    #[tokio::test]
    async fn rejected_tokens_skip_bcrypt_for_a_while() {
        let pool = test_pool().await;
        insert_bcrypt(&pool, "uk5_real").await;
        assert_eq!(
            verify_token(&pool, "uk5_junk_rejected").await,
            Ok(TokenVerdict::Invalid)
        );
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
        let token = mint_op_token();
        sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('t', ?, 'sha256')")
            .bind(hash_token(&token))
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            matches!(
                verify_token(&pool, &token).await,
                Ok(TokenVerdict::Operator(_))
            )
        );
        assert!(TOUCHED.lock().unwrap().get(&hash_token(&token)).is_some());

        // Clear the column; a second verification inside the interval must
        // not write it again.
        tokio::time::sleep(Duration::from_millis(50)).await;
        sqlx::query("UPDATE tokens SET last_used_at = NULL")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            matches!(
                verify_token(&pool, &token).await,
                Ok(TokenVerdict::Operator(_))
            )
        );
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

        assert!(
            matches!(
                verify_token(&pool, &first.unwrap()).await,
                Ok(TokenVerdict::Operator(_))
            )
        );
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
