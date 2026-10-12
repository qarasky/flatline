use std::path::Path;

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
pub const TOKEN_PREFIX: &str = "flatline_";

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

/// Verify a bearer token against the token table.
///
/// Two schemes coexist: sha256 for tokens minted here, bcrypt for API keys
/// imported from the Node database — so existing automation keeps working
/// after cutover. Bcrypt verification is deliberately last: it is slow, and
/// there are only ever a handful of imported keys.
pub async fn verify_token(pool: &SqlitePool, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }

    let digest = hash_token(token);
    let found: Option<TokenRow> = sqlx::query_as(
        "SELECT id, hash, active, expires FROM tokens WHERE hash = ? AND scheme = 'sha256'",
    )
    .bind(&digest)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    if let Some(row) = found {
        if !token_valid(&row) {
            return false;
        }
        touch(pool, row.id).await;
        return true;
    }

    let imported: Vec<TokenRow> = match sqlx::query_as(
        "SELECT id, hash, active, expires FROM tokens WHERE scheme = 'bcrypt'",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return false,
    };

    for row in imported {
        if token_valid(&row) && bcrypt::verify(token, &row.hash).unwrap_or(false) {
            touch(pool, row.id).await;
            return true;
        }
    }

    false
}

/// Record last use; failures are ignored — this is observability, not auth.
async fn touch(pool: &SqlitePool, id: i64) {
    let _ = sqlx::query(
        "UPDATE tokens SET last_used_at = strftime('%Y-%m-%d %H:%M:%S', 'now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await;
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

/// Middleware: every `/api/v1` route requires a valid bearer token.
/// The push endpoint authenticates by monitor token in the path instead and
/// is mounted separately.
pub async fn require_token(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty());

    match provided {
        Some(token) if verify_token(&state.pool, token).await => next.run(request).await,
        _ => unauthorized(),
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

        assert!(verify_token(&pool, &token).await);
        assert!(!verify_token(&pool, "flatline_wrong").await);
        assert!(!verify_token(&pool, "").await);

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
        let imported = "uk7_supersecret";
        let bcrypt_hash = bcrypt::hash(imported, 4).unwrap();

        sqlx::query("INSERT INTO tokens (name, hash, scheme) VALUES ('imported', ?, 'bcrypt')")
            .bind(&bcrypt_hash)
            .execute(&pool)
            .await
            .unwrap();

        assert!(
            verify_token(&pool, imported).await,
            "imported keys must keep working"
        );
        assert!(!verify_token(&pool, "uk7_wrong").await);
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

        assert!(verify_token(&pool, &first.unwrap()).await);
    }
}
