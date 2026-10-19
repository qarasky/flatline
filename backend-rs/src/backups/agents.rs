//! Dedicated backup-agent credentials.
//!
//! Backup agents carry their own bearer token, independent of operator API
//! keys and monitor push tokens. Only the SHA-256 hash is stored; the
//! plaintext is returned once at registration or rotation. Authenticated
//! runs are scoped by the agent UUID, so one agent can never read another's.

use rand::Rng;
use sqlx::SqlitePool;

use crate::auth::hash_token;

/// Visibly distinct from operator tokens (`flatline_`) and push tokens.
pub const TOKEN_PREFIX: &str = "flatline_backup_";

/// Mint a fresh backup credential. 20 random bytes, hex encoded.
pub fn mint_token() -> String {
    let mut bytes = [0u8; 20];
    rand::rng().fill_bytes(&mut bytes);
    format!("{TOKEN_PREFIX}{}", hex::encode(bytes))
}

/// Validate an agent display name: lowercase ASCII letters, digits, hyphens
/// and underscores, 1-64 characters, beginning with a letter or digit.
/// Names are labels only; storage is keyed by UUID.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    if name.len() > 64 {
        return false;
    }
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }

    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Resolve a bearer token to an active agent UUID, or None.
pub async fn authenticate(pool: &SqlitePool, token: &str) -> sqlx::Result<Option<String>> {
    if token.is_empty() {
        return Ok(None);
    }

    let digest = hash_token(token);
    let found: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM backup_agents
          WHERE token_hash = ? AND credential_active = 1
          LIMIT 1",
    )
    .bind(&digest)
    .fetch_optional(pool)
    .await?;

    Ok(found.map(|(id,)| id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_contract() {
        for valid in ["meks", "zhkhteam", "agent-1", "a_b", "0day"] {
            assert!(valid_name(valid), "{valid} must be valid");
        }
        for invalid in [
            "",
            "MeKS",
            "-meks",
            "_meks",
            "me ks",
            "me/ks",
            "meks.",
            &"a".repeat(65),
        ] {
            assert!(!valid_name(invalid), "{invalid:?} must be rejected");
        }
    }

    #[test]
    fn tokens_are_distinct_and_prefixed() {
        let first = mint_token();
        let second = mint_token();
        assert!(first.starts_with(TOKEN_PREFIX));
        assert_ne!(first, second);
    }
}
