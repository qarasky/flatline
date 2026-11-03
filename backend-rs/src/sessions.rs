//! Browser sessions behind the `fl_session` cookie.
//!
//! The cookie holds a random session id (`fls_` + 64 hex); only its SHA-256
//! is stored. A session belongs to one account and is created only by a
//! successful Kore ID sign-in. The foreign key deletes it with its account.
//! Lifetimes slide on use: [`ACCOUNT_SESSION_DAYS`] without use ends it.
//!
//! Legacy sessions made from an operator token (`sessions.token_id`) are
//! ignored: Kore ID is the only browser sign-in now. The column stays in the
//! schema; operator tokens authenticate `/api/v1` as bearer credentials.

use rand::Rng;
use sqlx::SqlitePool;

use crate::auth::{Principal, hash_token};

/// An account session ends after this many days without use.
pub const ACCOUNT_SESSION_DAYS: i64 = 30;
/// Prefix of a session id, so one is never mistaken for a token.
pub const SESSION_PREFIX: &str = "fls_";

/// Start an account session and return its id, the cookie value. Shown once.
pub async fn create(pool: &SqlitePool, user_id: i64) -> Result<String, sqlx::Error> {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let raw = format!("{SESSION_PREFIX}{}", hex::encode(bytes));
    sqlx::query("INSERT INTO sessions (hash, user_id) VALUES (?, ?)")
        .bind(hash_token(&raw))
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(raw)
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: i64,
    user_id: i64,
    idle_seconds: f64,
}

/// The principal behind a session id, or `None` when the session is unknown,
/// idle past its lifetime, or a legacy token session. Records use at most
/// once a minute.
pub async fn resolve(pool: &SqlitePool, raw: &str) -> Result<Option<Principal>, sqlx::Error> {
    if !raw.starts_with(SESSION_PREFIX) {
        return Ok(None);
    }
    let row: Option<SessionRow> = sqlx::query_as(
        "SELECT id, user_id,
                (julianday('now') - julianday(last_used_at)) * 86400.0 AS idle_seconds
         FROM sessions
         WHERE hash = ? AND user_id IS NOT NULL",
    )
    .bind(hash_token(raw))
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    if row.idle_seconds > (ACCOUNT_SESSION_DAYS * 86_400) as f64 {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(row.id)
            .execute(pool)
            .await?;
        return Ok(None);
    }
    if row.idle_seconds >= 60.0 {
        // Off the request path: a busy writer must not fail or stall a valid
        // session, and a missed touch is retried by the next request.
        let pool = pool.clone();
        tokio::spawn(async move {
            if let Err(error) = touch(&pool, row.id).await {
                tracing::warn!("sessions: could not record use: {error}");
            }
        });
    }
    Ok(Some(Principal::Account {
        user_id: row.user_id,
    }))
}

/// Slide the session forward.
async fn touch(pool: &SqlitePool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE sessions SET last_used_at = strftime('%Y-%m-%d %H:%M:%S', 'now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
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

/// Remember what a Kore ID sign-in returned: the id token, the hint for
/// provider-side sign-out, and the Kore ID session id (`sid`) that
/// back-channel logout names.
pub async fn set_sso_details(
    pool: &SqlitePool,
    raw: &str,
    id_token: &str,
    sid: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sessions SET sso_id_token = ?, sso_sid = ? WHERE hash = ?")
        .bind(id_token)
        .bind(sid)
        .bind(hash_token(raw))
        .execute(pool)
        .await?;
    Ok(())
}

/// The Kore ID id token a session was made with, if any.
pub async fn sso_id_token(pool: &SqlitePool, raw: &str) -> Result<Option<String>, sqlx::Error> {
    let token: Option<Option<String>> =
        sqlx::query_scalar("SELECT sso_id_token FROM sessions WHERE hash = ?")
            .bind(hash_token(raw))
            .fetch_optional(pool)
            .await?;
    Ok(token.flatten())
}

/// End the local sessions a Kore ID back-channel logout names: every
/// session made from that Kore ID session (`sid`), or, for a token without
/// a `sid`, every Kore ID-made session of the account tied to that `sub`.
/// Sessions not made through Kore ID are left alone. Returns how many ended.
pub async fn end_for_kore_logout(
    pool: &SqlitePool,
    target: &crate::sso::LogoutTarget,
) -> Result<u64, sqlx::Error> {
    let result = match target {
        crate::sso::LogoutTarget::Sid(sid) => {
            sqlx::query("DELETE FROM sessions WHERE sso_sid = ?")
                .bind(sid)
                .execute(pool)
                .await?
        }
        crate::sso::LogoutTarget::Sub(sub) => {
            sqlx::query(
                "DELETE FROM sessions WHERE sso_id_token IS NOT NULL
                   AND user_id IN (SELECT id FROM users WHERE kore_sub = ?)",
            )
            .bind(sub)
            .execute(pool)
            .await?
        }
    };
    Ok(result.rows_affected())
}
