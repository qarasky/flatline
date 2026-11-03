//! Member accounts: people who sign in with Kore ID.
//!
//! Every account has full permission, the same as an operator token; there
//! are no roles. An account has no password: Kore ID is the only browser
//! sign-in. The `users.password_hash` column stays in the schema for older
//! databases, but new accounts store [`SSO_PASSWORD_SENTINEL`] there and a
//! legacy account's hash is overwritten when it links to Kore ID. Nothing
//! verifies a password any more.

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::api::ApiError;

/// Longest name shown in the sidebar and the Members list.
const MAX_NAME_CHARS: usize = 100;
/// Longest email accepted (RFC 5321's path limit).
const MAX_EMAIL_CHARS: usize = 254;

/// A member account, without its password hash.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub name: String,
    pub created_at: String,
    /// The Kore ID subject, once the account has signed in through SSO.
    pub kore_sub: Option<String>,
}

impl Account {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "createdAt": self.created_at,
            "sso": self.kore_sub.is_some(),
        })
    }
}

#[derive(Debug)]
pub enum AccountError {
    BadEmail,
    BadName,
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

/// The `Account` columns, as a literal so queries stay static strings.
macro_rules! columns {
    () => {
        "id, email, name, created_at, kore_sub"
    };
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

/// The account a credential acts for, as a token maker: `(id, name)` for an
/// account session, `None` for a bearer token.
pub async fn maker(
    pool: &SqlitePool,
    principal: &crate::auth::Principal,
) -> Result<Option<(i64, String)>, AccountError> {
    match principal {
        crate::auth::Principal::Account { user_id } => {
            let account = get(pool, *user_id).await?;
            Ok(Some((account.id, account.name)))
        }
        crate::auth::Principal::Token { .. } => Ok(None),
    }
}

/// The `password_hash` of an account made by SSO: not a bcrypt hash, so no
/// password ever matches it. The column is `NOT NULL` in the original
/// schema; this sentinel keeps it satisfied without using passwords.
pub const SSO_PASSWORD_SENTINEL: &str = "!sso";

/// Why a Kore ID identity did not get an account.
#[derive(Debug, PartialEq, Eq)]
pub enum SsoDenied {
    /// Provisioning is off, or the identity is not on the optional
    /// `KORE_ID_ALLOWED_EMAILS` / `KORE_ID_ALLOWED_SUBS` filter.
    NotAllowed,
    /// The provider sent no usable email.
    NoEmail,
    /// The email belongs to a local account already tied to another subject,
    /// or to a local account while the provider does not vouch for the
    /// address (`email_verified` not true), so it cannot be linked.
    Conflict,
}

/// The account a verified Kore ID identity signs in as.
///
/// An account already tied to this `sub` signs in (its name and email follow
/// the provider). Otherwise Kore ID has already decided this person may use
/// the app (per-user app access), so an account is created, or an existing
/// local one with the same email is linked when the provider marks the email
/// verified. `KORE_ID_AUTO_PROVISION=false` turns creation off; the
/// allowlists, when set, are an extra filter on top. Every account is a full
/// operator: access is managed in Kore ID's admin.
pub async fn sso_sign_in(
    pool: &SqlitePool,
    kore: &crate::config::KoreIdConfig,
    claims: &crate::sso::Claims,
) -> Result<Result<Account, SsoDenied>, AccountError> {
    let existing: Option<Account> = sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM users WHERE kore_sub = ?"
    ))
    .bind(&claims.sub)
    .fetch_optional(pool)
    .await?;
    let email = claims
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty());
    let verified = claims.email_verified == Some(true);
    let name = claims
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.chars().count() <= MAX_NAME_CHARS);

    if let Some(account) = existing {
        // Follow the provider's profile; a clash with another account's email
        // keeps the old one rather than failing the sign-in.
        if let Some(name) = name
            && name != account.name
        {
            sqlx::query("UPDATE users SET name = ? WHERE id = ?")
                .bind(name)
                .bind(account.id)
                .execute(pool)
                .await?;
        }
        if let Some(email) = email
            && verified
            && clean_email(email).is_ok()
            && email_key(email) != email_key(&account.email)
        {
            let _ = sqlx::query("UPDATE users SET email = ?, email_key = ? WHERE id = ?")
                .bind(email)
                .bind(email_key(email))
                .bind(account.id)
                .execute(pool)
                .await;
        }
        return Ok(Ok(get(pool, account.id).await?));
    }

    let Some(email) = email.filter(|e| clean_email(e).is_ok()) else {
        return Ok(Err(SsoDenied::NoEmail));
    };
    let key = email_key(email);
    let filtered = !kore.allowed_subs.is_empty() || !kore.allowed_emails.is_empty();
    let allowed = if filtered {
        kore.allowed_subs.contains(&claims.sub) || (verified && kore.allowed_emails.contains(&key))
    } else {
        kore.auto_provision
    };
    if !allowed {
        return Ok(Err(SsoDenied::NotAllowed));
    }

    let local: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, kore_sub FROM users WHERE email_key = ?")
            .bind(&key)
            .fetch_optional(pool)
            .await?;
    if let Some((id, tied)) = local {
        // Linking takes over a local account by email: only when the
        // provider vouches for the address. Its old password hash is
        // overwritten, so the account has no password after linking.
        if tied.is_some() || !verified {
            return Ok(Err(SsoDenied::Conflict));
        }
        sqlx::query(
            "UPDATE users SET kore_sub = ?, password_hash = ?, must_change_password = 0
             WHERE id = ? AND kore_sub IS NULL",
        )
        .bind(&claims.sub)
        .bind(SSO_PASSWORD_SENTINEL)
        .bind(id)
        .execute(pool)
        .await?;
        return Ok(Ok(get(pool, id).await?));
    }

    let name = name.map(str::to_string).unwrap_or_else(|| {
        email
            .split('@')
            .next()
            .unwrap_or(email)
            .chars()
            .take(MAX_NAME_CHARS)
            .collect()
    });
    let account = sqlx::query_as(concat!(
        "INSERT INTO users (email, email_key, name, password_hash, must_change_password,
                            password_set_at, kore_sub)
         VALUES (?, ?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%S', 'now'), ?)
         RETURNING ",
        columns!()
    ))
    .bind(email)
    .bind(&key)
    .bind(&name)
    .bind(SSO_PASSWORD_SENTINEL)
    .bind(&claims.sub)
    .fetch_one(pool)
    .await?;
    Ok(Ok(account))
}

/// The account tied to a Kore ID subject, if it has signed in through SSO.
pub async fn by_kore_sub(pool: &SqlitePool, sub: &str) -> Result<Option<Account>, AccountError> {
    Ok(sqlx::query_as(concat!(
        "SELECT ",
        columns!(),
        " FROM users WHERE kore_sub = ?"
    ))
    .bind(sub)
    .fetch_optional(pool)
    .await?)
}
