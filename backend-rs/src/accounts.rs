//! Member accounts: people who sign in with an email and a password.
//!
//! Every account has full permission, the same as an operator token; there
//! are no roles. Passwords are stored only as bcrypt hashes, computed off the
//! async runtime. A password set by someone else (on add or reset) is a
//! starting password: the account must choose its own before doing anything
//! else, and an unchanged starting password expires after
//! [`STARTING_PASSWORD_DAYS`].

use std::sync::OnceLock;

use axum::http::StatusCode;
use chrono::NaiveDateTime;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::api::ApiError;

/// The shortest password accepted. No other rule.
pub const MIN_PASSWORD_CHARS: usize = 10;
/// How long an unchanged starting password stays usable.
pub const STARTING_PASSWORD_DAYS: i64 = 7;
/// Longest name shown in the sidebar and the Members list.
const MAX_NAME_CHARS: usize = 100;
/// Longest email accepted (RFC 5321's path limit).
const MAX_EMAIL_CHARS: usize = 254;
/// bcrypt cost when `FLATLINE_PASSWORD_COST` is unset.
const DEFAULT_PASSWORD_COST: u32 = 12;

static PASSWORD_COST: OnceLock<u32> = OnceLock::new();
static DUMMY_HASH: OnceLock<String> = OnceLock::new();

/// A member account, without its password hash.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub name: String,
    pub must_change_password: bool,
    pub password_set_at: String,
    pub created_at: String,
}

impl Account {
    /// A starting password (still unchanged) set more than
    /// [`STARTING_PASSWORD_DAYS`] ago.
    pub fn starting_password_expired(&self) -> bool {
        if !self.must_change_password {
            return false;
        }
        match NaiveDateTime::parse_from_str(&self.password_set_at, "%Y-%m-%d %H:%M:%S") {
            Ok(set_at) => {
                chrono::Utc::now().naive_utc() - set_at
                    > chrono::Duration::days(STARTING_PASSWORD_DAYS)
            }
            // An unreadable timestamp is treated as expired: a reset fixes it.
            Err(_) => true,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "mustChangePassword": self.must_change_password,
            "startingPasswordExpired": self.starting_password_expired(),
            "createdAt": self.created_at,
        })
    }
}

#[derive(Debug)]
pub enum AccountError {
    BadEmail,
    BadName,
    WeakPassword,
    EmailTaken,
    NotFound,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for AccountError {
    fn from(error: sqlx::Error) -> Self {
        let unique = error
            .as_database_error()
            .is_some_and(|db| db.is_unique_violation());
        if unique {
            AccountError::EmailTaken
        } else {
            AccountError::Db(error)
        }
    }
}

impl From<AccountError> for ApiError {
    fn from(error: AccountError) -> Self {
        match error {
            AccountError::BadEmail => ApiError::new(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "`email` must be an address like name@example.com.",
            )
            .with_hint("Send one `@` with text on both sides, at most 254 characters."),
            AccountError::BadName => ApiError::new(
                StatusCode::BAD_REQUEST,
                "bad_request",
                format!("`name` must be 1 to {MAX_NAME_CHARS} characters."),
            ),
            AccountError::WeakPassword => ApiError::new(
                StatusCode::BAD_REQUEST,
                "weak_password",
                format!("Use at least {MIN_PASSWORD_CHARS} characters."),
            )
            .with_hint("Any characters are allowed; only the length is checked."),
            AccountError::EmailTaken => ApiError::new(
                StatusCode::CONFLICT,
                "email_taken",
                "An account with that email already exists.",
            )
            .with_hint("Emails are compared ignoring case. List members with `GET /api/v1/users`."),
            AccountError::NotFound => ApiError::not_found("No account with that id."),
            AccountError::Db(error) => {
                tracing::error!("accounts: {error}");
                ApiError::server()
            }
        }
    }
}

/// bcrypt cost: `FLATLINE_PASSWORD_COST` (clamped to 4..=31), else 12.
pub fn password_cost() -> u32 {
    *PASSWORD_COST.get_or_init(|| {
        std::env::var("FLATLINE_PASSWORD_COST")
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .map(|cost| cost.clamp(4, 31))
            .unwrap_or(DEFAULT_PASSWORD_COST)
    })
}

/// Fix the bcrypt cost before first use. Test harnesses call this so they do
/// not mutate the environment of a multi-threaded process; a later call has
/// no effect.
pub fn set_password_cost(cost: u32) {
    let _ = PASSWORD_COST.set(cost.clamp(4, 31));
}

/// Hash a password with bcrypt, off the async runtime.
pub async fn hash_password(password: String) -> String {
    let cost = password_cost();
    tokio::task::spawn_blocking(move || bcrypt::hash(password, cost))
        .await
        .expect("the bcrypt worker does not panic")
        .expect("bcrypt hashes any input at a valid cost")
}

/// Check a password against a hash, off the async runtime. A malformed hash
/// never matches.
async fn check_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false))
        .await
        .unwrap_or(false)
}

/// A hash to compare against when the email is unknown, so a miss costs the
/// same as a wrong password. Made once, at the configured cost.
async fn dummy_hash() -> String {
    if let Some(hash) = DUMMY_HASH.get() {
        return hash.clone();
    }
    let hash = hash_password("flatline: no such account".to_string()).await;
    DUMMY_HASH.get_or_init(|| hash).clone()
}

/// The lowercased form that carries email uniqueness.
pub fn email_key(email: &str) -> String {
    email.trim().to_lowercase()
}

fn clean_email(email: &str) -> Result<String, AccountError> {
    let email = email.trim();
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(AccountError::BadEmail);
    };
    if local.is_empty()
        || domain.is_empty()
        || email.chars().count() > MAX_EMAIL_CHARS
        || email.chars().any(char::is_whitespace)
    {
        return Err(AccountError::BadEmail);
    }
    Ok(email.to_string())
}

fn clean_name(name: &str) -> Result<String, AccountError> {
    let name = name.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS {
        return Err(AccountError::BadName);
    }
    Ok(name.to_string())
}

fn check_strength(password: &str) -> Result<(), AccountError> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AccountError::WeakPassword);
    }
    Ok(())
}

/// The `Account` columns, as a literal so queries stay static strings.
macro_rules! columns {
    () => {
        "id, email, name, must_change_password, password_set_at, created_at"
    };
}

/// Add an account. `must_change` marks the password as a starting password.
pub async fn create(
    pool: &SqlitePool,
    email: &str,
    name: &str,
    password: &str,
    must_change: bool,
) -> Result<Account, AccountError> {
    let email = clean_email(email)?;
    let name = clean_name(name)?;
    check_strength(password)?;
    let hash = hash_password(password.to_string()).await;
    let account = sqlx::query_as(concat!(
        "INSERT INTO users (email, email_key, name, password_hash, must_change_password, password_set_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now'))
         RETURNING ",
        columns!()
    ))
    .bind(&email)
    .bind(email_key(&email))
    .bind(&name)
    .bind(&hash)
    .bind(i64::from(must_change))
    .fetch_one(pool)
    .await?;
    Ok(account)
}

/// Create the first account (no starting password), or `None` when an
/// account already exists. The check and the insert are one statement, so
/// two setups racing on a fresh install cannot both succeed.
pub async fn create_first(
    pool: &SqlitePool,
    email: &str,
    name: &str,
    password: &str,
) -> Result<Option<Account>, AccountError> {
    let email = clean_email(email)?;
    let name = clean_name(name)?;
    check_strength(password)?;
    let hash = hash_password(password.to_string()).await;
    let account = sqlx::query_as(concat!(
        "INSERT INTO users (email, email_key, name, password_hash, must_change_password, password_set_at)
         SELECT ?, ?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%S', 'now')
         WHERE NOT EXISTS (SELECT 1 FROM users)
         RETURNING ",
        columns!()
    ))
    .bind(&email)
    .bind(email_key(&email))
    .bind(&name)
    .bind(&hash)
    .fetch_optional(pool)
    .await?;
    Ok(account)
}

/// Every account, by name.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Account>, AccountError> {
    Ok(sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM users ORDER BY name COLLATE NOCASE, id"
    ))
    .fetch_all(pool)
    .await?)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Account, AccountError> {
    sqlx::query_as(concat!("SELECT ", columns!(), " FROM users WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AccountError::NotFound)
}

pub async fn count(pool: &SqlitePool) -> Result<i64, AccountError> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?)
}

/// Change an account's name and/or email.
pub async fn update(
    pool: &SqlitePool,
    id: i64,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<Account, AccountError> {
    let name = name.map(clean_name).transpose()?;
    let email = email.map(clean_email).transpose()?;
    let result = sqlx::query(
        "UPDATE users SET
             name = COALESCE(?, name),
             email = COALESCE(?, email),
             email_key = COALESCE(?, email_key)
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&email)
    .bind(email.as_deref().map(email_key))
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AccountError::NotFound);
    }
    get(pool, id).await
}

/// Replace an account's password. `must_change` makes it a starting
/// password (a reset); the clock for its expiry starts now.
pub async fn set_password(
    pool: &SqlitePool,
    id: i64,
    password: &str,
    must_change: bool,
) -> Result<Account, AccountError> {
    check_strength(password)?;
    let hash = hash_password(password.to_string()).await;
    let result = sqlx::query(
        "UPDATE users SET password_hash = ?, must_change_password = ?,
             password_set_at = strftime('%Y-%m-%d %H:%M:%S', 'now')
         WHERE id = ?",
    )
    .bind(&hash)
    .bind(i64::from(must_change))
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AccountError::NotFound);
    }
    get(pool, id).await
}

/// Remove an account. Its sessions go with it; tokens it made keep working
/// and keep the maker's name.
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), AccountError> {
    let result = sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AccountError::NotFound);
    }
    Ok(())
}

/// The account for this email and password, or `None`. An unknown email is
/// checked against a dummy hash so the answer takes as long as a wrong
/// password.
pub async fn verify_password(
    pool: &SqlitePool,
    email: &str,
    password: &str,
) -> Result<Option<Account>, AccountError> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE email_key = ?")
            .bind(email_key(email))
            .fetch_optional(pool)
            .await?;
    let (id, hash) = match row {
        Some((id, hash)) => (Some(id), hash),
        None => (None, dummy_hash().await),
    };
    let matched = check_password(password.to_string(), hash).await;
    match (id, matched) {
        (Some(id), true) => match get(pool, id).await {
            Ok(account) => Ok(Some(account)),
            // Removed between the two reads.
            Err(AccountError::NotFound) => Ok(None),
            Err(error) => Err(error),
        },
        _ => Ok(None),
    }
}

/// The account a credential acts for, as a token maker: `(id, name)` for an
/// account session, `None` for a bearer token or token session.
pub async fn maker(
    pool: &SqlitePool,
    principal: &crate::auth::Principal,
) -> Result<Option<(i64, String)>, AccountError> {
    match principal {
        crate::auth::Principal::Account { user_id, .. } => {
            let account = get(pool, *user_id).await?;
            Ok(Some((account.id, account.name)))
        }
        crate::auth::Principal::Token { .. } => Ok(None),
    }
}

/// Whether `password` is this account's current password.
pub async fn password_matches(
    pool: &SqlitePool,
    id: i64,
    password: &str,
) -> Result<bool, AccountError> {
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AccountError::NotFound)?;
    Ok(check_password(password.to_string(), hash).await)
}

/// Failed password sign-ins allowed per email in one window.
pub const SIGN_IN_FAILURES_PER_EMAIL: u32 = 5;
/// Failed password sign-ins allowed per client address in one window.
pub const SIGN_IN_FAILURES_PER_ADDRESS: u32 = 20;
/// The window both limits count over.
pub const SIGN_IN_WINDOW: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Keys kept before expired windows are swept, so junk input cannot grow
/// the maps without bound.
const SIGN_IN_SWEEP_AT: usize = 10_000;

/// Fixed-window counters of email/password sign-ins, per email and per
/// client address. Every attempt is counted before its password is checked
/// ([`SignInLimiter::reserve`]), so parallel guesses cannot all slip in
/// before the first failure lands; a success then gives its count back
/// ([`SignInLimiter::succeeded`]). A limited attempt is refused before the
/// password is checked, so even the right password waits.
#[derive(Default)]
pub struct SignInLimiter {
    by_email: std::sync::Mutex<Windows>,
    by_address: std::sync::Mutex<Windows>,
}

/// Key -> (window start, failures in it).
type Windows = std::collections::HashMap<String, (std::time::Instant, u32)>;

/// Seconds until `key`'s window reopens, when it has used its budget.
fn wait_for(windows: &Windows, key: &str, limit: u32, now: std::time::Instant) -> Option<u64> {
    let (started, count) = windows.get(key)?;
    let elapsed = now.duration_since(*started);
    if elapsed >= SIGN_IN_WINDOW || *count < limit {
        return None;
    }
    Some((SIGN_IN_WINDOW - elapsed).as_secs().max(1))
}

fn bump(windows: &mut Windows, key: &str, now: std::time::Instant) {
    if windows.len() >= SIGN_IN_SWEEP_AT {
        windows.retain(|_, (started, _)| now.duration_since(*started) < SIGN_IN_WINDOW);
    }
    let entry = windows.entry(key.to_string()).or_insert((now, 0));
    if now.duration_since(entry.0) >= SIGN_IN_WINDOW {
        *entry = (now, 0);
    }
    entry.1 += 1;
}

impl SignInLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Count an attempt for the email and the address, or `Err(seconds to
    /// wait)` without counting when either has used its budget. Both maps
    /// are held together, so the check and the count are one step.
    pub fn reserve(&self, email_key: &str, address: &str) -> Result<(), u64> {
        let now = std::time::Instant::now();
        let mut by_email = self.by_email.lock().unwrap();
        let mut by_address = self.by_address.lock().unwrap();
        let email = wait_for(&by_email, email_key, SIGN_IN_FAILURES_PER_EMAIL, now);
        let address_wait = wait_for(&by_address, address, SIGN_IN_FAILURES_PER_ADDRESS, now);
        if let Some(wait) = email.max(address_wait) {
            return Err(wait);
        }
        bump(&mut by_email, email_key, now);
        bump(&mut by_address, address, now);
        Ok(())
    }

    /// The attempt signed in: the email starts afresh and the address gets
    /// its count back. A failed attempt keeps what `reserve` counted.
    pub fn succeeded(&self, email_key: &str, address: &str) {
        self.by_email.lock().unwrap().remove(email_key);
        if let Some((_, count)) = self.by_address.lock().unwrap().get_mut(address) {
            *count = count.saturating_sub(1);
        }
    }
}
