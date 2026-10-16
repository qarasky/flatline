//! Server -> website monitor links.
//!
//! A "server" is a monitor that emits metrics (usually `push`). Each server
//! links website monitors that appear as status chips on its Superboard card.
//! A link may point at a `group`, expanded to its non-group descendants on
//! read, so linking a whole group links every website inside it — including
//! ones added later. Mirrors the Node `server/monitor-links.js`.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::api::ApiError;

/// Status the SPA uses for "no heartbeat yet".
const PENDING: i64 = 2;

/// Upper bound on links per server, matching the API's input cap.
pub const MAX_LINKS: usize = 200;

/// A raw stored link joined with its target's current status.
#[derive(sqlx::FromRow)]
struct RawRow {
    linked_monitor_id: i64,
    name: String,
    #[sqlx(rename = "type")]
    kind: String,
    status: Option<i64>,
    ping: Option<f64>,
}

/// A resolved target monitor with its status.
#[derive(sqlx::FromRow)]
struct TargetRow {
    id: i64,
    name: String,
    #[sqlx(rename = "type")]
    kind: String,
    url: Option<String>,
    status: Option<i64>,
    ping: Option<f64>,
    last_check: Option<String>,
}

/// Resolve a server's links: raw stored links plus every concrete monitor
/// they point at, each with current status. `via` names the raw link that
/// pulled a resolved monitor in (itself for a direct link, the group id for a
/// group child).
pub async fn resolve(pool: &SqlitePool, monitor_id: i64) -> Result<(Vec<Value>, Vec<Value>), ApiError> {
    let raw = raw_links(pool, monitor_id).await?;

    let raw_json: Vec<Value> = raw
        .iter()
        .map(|row| {
            json!({
                "linkedMonitorId": row.linked_monitor_id,
                "name": row.name,
                "type": row.kind,
                "status": row.status.unwrap_or(PENDING),
                "ping": row.ping,
            })
        })
        .collect();

    // Expand group links to concrete monitors, keeping link order and
    // dropping duplicates. The server can never link itself, even when one of
    // its own groups contains it.
    let mut ids: Vec<i64> = Vec::new();
    let mut via: HashMap<i64, i64> = HashMap::new();
    let mut seen: HashSet<i64> = HashSet::new();

    for link in &raw {
        let candidates: Vec<i64> = if link.kind == "group" {
            descendants(pool, link.linked_monitor_id).await?
        } else {
            vec![link.linked_monitor_id]
        };
        for id in candidates {
            if id == monitor_id || !seen.insert(id) {
                continue;
            }
            via.insert(id, link.linked_monitor_id);
            ids.push(id);
        }
    }

    let targets = load_targets(pool, &ids).await?;
    let mut resolved = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Some(target) = targets.get(id) {
            resolved.push(json!({
                "id": target.id,
                "name": target.name,
                "type": target.kind,
                "status": target.status.unwrap_or(PENDING),
                "ping": target.ping,
                "url": target.url,
                "lastCheck": target.last_check,
                "via": via.get(id).copied().unwrap_or(*id),
            }));
        }
    }

    Ok((raw_json, resolved))
}

/// Resolve links for several servers, omitting those with no links.
/// Returns `(count, servers)` where `servers` is keyed by server id.
pub async fn for_many(pool: &SqlitePool, ids: &[i64]) -> Result<(i64, Value), ApiError> {
    let mut servers = serde_json::Map::new();
    let mut count = 0i64;

    for id in ids {
        let (raw, resolved) = resolve(pool, *id).await?;
        if !raw.is_empty() {
            servers.insert(id.to_string(), json!({ "raw": raw, "resolved": resolved }));
            count += 1;
        }
    }

    Ok((count, Value::Object(servers)))
}

/// Replace a server's links with exactly the supplied ids.
///
/// Non-positive ids, the server itself and duplicates are dropped; ids that
/// no longer exist are skipped, since the target may have been deleted
/// between the picker loading and the save.
pub async fn replace(pool: &SqlitePool, monitor_id: i64, linked: &[i64]) -> Result<(), ApiError> {
    let mut ids: Vec<i64> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for id in linked.iter().take(MAX_LINKS) {
        if *id <= 0 || *id == monitor_id || !seen.insert(*id) {
            continue;
        }
        ids.push(*id);
    }

    let existing: Vec<i64> = if ids.is_empty() {
        Vec::new()
    } else {
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!("SELECT id FROM monitors WHERE id IN ({placeholders})");
        let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
        for id in &ids {
            query = query.bind(id);
        }
        query.fetch_all(pool).await.map_err(internal)?
    };

    sqlx::query("DELETE FROM monitor_links WHERE monitor_id = ?")
        .bind(monitor_id)
        .execute(pool)
        .await
        .map_err(internal)?;

    for id in existing {
        sqlx::query("INSERT INTO monitor_links (monitor_id, linked_monitor_id) VALUES (?, ?)")
            .bind(monitor_id)
            .bind(id)
            .execute(pool)
            .await
            .map_err(internal)?;
    }

    Ok(())
}

/// Remove every link belonging to a server.
pub async fn clear(pool: &SqlitePool, monitor_id: i64) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM monitor_links WHERE monitor_id = ?")
        .bind(monitor_id)
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

/// Raw links for one server, joined with the target's current status.
async fn raw_links(pool: &SqlitePool, monitor_id: i64) -> Result<Vec<RawRow>, ApiError> {
    sqlx::query_as::<_, RawRow>(
        "SELECT ml.linked_monitor_id AS linked_monitor_id,
                m.name AS name, m.type AS type,
                (SELECT status FROM heartbeats WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS status,
                (SELECT ping FROM heartbeats WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS ping
         FROM monitor_links ml
         JOIN monitors m ON m.id = ml.linked_monitor_id
         WHERE ml.monitor_id = ?
         ORDER BY ml.id",
    )
    .bind(monitor_id)
    .fetch_all(pool)
    .await
    .map_err(internal)
}

/// Every descendant id of a monitor, breadth-first and cycle-safe.
async fn descendants(pool: &SqlitePool, root: i64) -> Result<Vec<i64>, ApiError> {
    let mut out = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut frontier = vec![root];

    while !frontier.is_empty() {
        let placeholders = vec!["?"; frontier.len()].join(",");
        let sql = format!("SELECT id FROM monitors WHERE parent IN ({placeholders}) ORDER BY id");
        let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
        for parent in &frontier {
            query = query.bind(parent);
        }
        let children = query.fetch_all(pool).await.map_err(internal)?;

        let mut next = Vec::new();
        for id in children {
            if id != root && seen.insert(id) {
                out.push(id);
                next.push(id);
            }
        }
        frontier = next;
    }

    Ok(out)
}

/// Load a set of monitors with their latest status in one query.
async fn load_targets(pool: &SqlitePool, ids: &[i64]) -> Result<HashMap<i64, TargetRow>, ApiError> {
    let mut targets = HashMap::new();
    if ids.is_empty() {
        return Ok(targets);
    }

    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT m.id AS id, m.name AS name, m.type AS type, m.url AS url,
                (SELECT status FROM heartbeats WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS status,
                (SELECT ping FROM heartbeats WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS ping,
                (SELECT time FROM heartbeats WHERE monitor_id = m.id ORDER BY time DESC, id DESC LIMIT 1) AS last_check
         FROM monitors m WHERE m.id IN ({placeholders})"
    );
    let mut query = sqlx::query_as::<_, TargetRow>(sqlx::AssertSqlSafe(sql));
    for id in ids {
        query = query.bind(id);
    }

    for row in query.fetch_all(pool).await.map_err(internal)? {
        targets.insert(row.id, row);
    }
    Ok(targets)
}

fn internal(e: sqlx::Error) -> ApiError {
    tracing::error!("links: {e}");
    ApiError::server()
}
