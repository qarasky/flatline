//! Browser sessions behind the `fl_session` cookie.
//!
//! The cookie holds a random session id (`fls_` + 64 hex); only its SHA-256
//! is stored. A session belongs to one account (email/password sign-in) or
//! one operator token (token sign-in, the wall TV), and goes with it: the
//! foreign keys delete it with its account or token, and a token that is
//! disabled or expired stops its sessions at the next request. Lifetimes
//! slide on use: [`ACCOUNT_SESSION_DAYS`] for an account,
//! [`TOKEN_SESSION_DAYS`] for a token.

use rand::Rng;
use sqlx::SqlitePool;

use crate::auth::{Principal, hash_token, token_usable};

/// An account session ends after this many days without use.
pub const ACCOUNT_SESSION_DAYS: i64 = 30;
/// A token session ends after this many days without use (the cookie's own
/// 400-day limit).
pub const TOKEN_SESSION_DAYS: i64 = 400;
/// Prefix of a session id, so one is never mistaken for a token.
pub const SESSION_PREFIX: &str = "fls_";

/// Who a new session belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionOwner {
    Account(i64),
    Token(i64),
}

/// Start a session and return its id, the cookie value. Shown once.
pub async fn create(pool: &SqlitePool, owner: SessionOwner) -> Result<String, sqlx::Error> {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let raw = format!("{SESSION_PREFIX}{}", hex::encode(bytes));
    let (user_id, token_id) = match owner {
        SessionOwner::Account(id) => (Some(id), None),
        SessionOwner::Token(id) => (None, Some(id)),
    };
    sqlx::query("INSERT INTO sessions (hash, user_id, token_id) VALUES (?, ?, ?)")
        .bind(hash_token(&raw))
        .bind(user_id)
        .bind(token_id)
        .execute(pool)
        .await?;
    Ok(raw)
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: i64,
    user_id: Option<i64>,
    token_id: Option<i64>,
    idle_seconds: f64,
    must_change_password: Option<bool>,
    token_active: Option<i64>,
    token_expires: Option<String>,
}

/// The principal behind a session id, or `None` when the session is
/// unknown, idle past its lifetime, or made from a token that is no longer
/// usable. Records use at most once a minute.
pub async fn resolve(pool: &SqlitePool, raw: &str) -> Result<Option<Principal>, sqlx::Error> {
    if !raw.starts_with(SESSION_PREFIX) {
        return Ok(None);
    }
    let row: Option<SessionRow> = sqlx::query_as(
        "SELECT s.id, s.user_id, s.token_id,
                (julianday('now') - julianday(s.last_used_at)) * 86400.0 AS idle_seconds,
                u.must_change_password, t.active AS token_active, t.expires AS token_expires
         FROM sessions s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN tokens t ON t.id = s.token_id
         WHERE s.hash = ?",
    )
    .bind(hash_token(raw))
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    let (principal, lifetime_days) = match (row.user_id, row.token_id) {
        (Some(user_id), None) => match row.must_change_password {
            Some(must_change_password) => (
                Principal::Account {
                    user_id,
                    must_change_password,
                },
                ACCOUNT_SESSION_DAYS,
            ),
            None => return Ok(None),
        },
        (None, Some(token_id)) => {
            let Some(active) = row.token_active else {
                return Ok(None);
            };
            if !token_usable(active, row.token_expires.as_deref()) {
                return Ok(None);
            }
            (Principal::Token { token_id }, TOKEN_SESSION_DAYS)
        }
        _ => return Ok(None),
    };

    if row.idle_seconds > (lifetime_days * 86_400) as f64 {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(row.id)
            .execute(pool)
            .await?;
        return Ok(None);
    }
    if row.idle_seconds >= 60.0 {
        touch(pool, row.id, row.token_id).await?;
    }
    Ok(Some(principal))
}

/// Slide the session forward; a token session also marks its token used,
/// as signing in with the token itself would.
async fn touch(pool: &SqlitePool, id: i64, token_id: Option<i64>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE sessions SET last_used_at = strftime('%Y-%m-%d %H:%M:%S', 'now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    if let Some(token_id) = token_id {
        sqlx::query(
            "UPDATE tokens SET last_used_at = strftime('%Y-%m-%d %H:%M:%S', 'now') WHERE id = ?",
        )
        .bind(token_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// End one session (signing out). Unknown ids are ignored.
pub async fn end(pool: &SqlitePool, raw: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE hash = ?")
        .bind(hash_token(raw))
        .execute(pool)
        .await?;
    Ok(())
}

/// End every session of an account, except `keep` (the caller's own, when
/// they changed their password).
pub async fn end_for_account(
    pool: &SqlitePool,
    user_id: i64,
    keep: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND hash != ?")
        .bind(user_id)
        .bind(keep.map(hash_token).unwrap_or_default())
        .execute(pool)
        .await?;
    Ok(())
}
