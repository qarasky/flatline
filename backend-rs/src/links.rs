//! Server -> website monitor links.
//!
//! A "server" is a monitor that emits metrics (usually `push`). Each server
//! links website monitors (HTTP/HTTPS) that appear as status chips on its
//! Superboard card. A link may point at a `group`, expanded to the website
//! monitors beneath it on read, so linking a whole group links every website
//! inside it — including ones added later. Non-website monitors are never
//! linkable: only websites are chips.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::api::ApiError;

/// Status the SPA uses for "no heartbeat yet".
const PENDING: i64 = 2;

/// Upper bound on links per server, matching the API's input cap.
pub const MAX_LINKS: usize = 200;

/// Monitor types that count as a hosted website. Only HTTP(S) monitors are
/// linkable: a server's card shows the sites it hosts, not other servers or
/// ping checks, so a stored link to anything else is ignored.
fn is_website(kind: &str) -> bool {
    matches!(kind, "http" | "https")
}

/// Bound parameters per `IN (…)` statement, well under SQLite's limit.
const IN_CHUNK: usize = 500;

/// A raw stored link with its target's identity.
#[derive(sqlx::FromRow)]
struct LinkRow {
    monitor_id: i64,
    linked_monitor_id: i64,
    name: String,
    #[sqlx(rename = "type")]
    kind: String,
}

/// A resolved target monitor's identity.
#[derive(sqlx::FromRow)]
struct TargetRow {
    id: i64,
    name: String,
    #[sqlx(rename = "type")]
    kind: String,
    url: Option<String>,
}

/// Raw links and resolved targets for one server.
type Resolved = (Vec<Value>, Vec<Value>);

/// Resolve a server's links: raw stored links plus every concrete monitor
/// they point at, each with current status. `via` names the raw link that
/// pulled a resolved monitor in (itself for a direct link, the group id for a
/// group child).
pub async fn resolve(pool: &SqlitePool, monitor_id: i64) -> Result<Resolved, ApiError> {
    let mut all = resolve_many(pool, &[monitor_id]).await?;
    Ok(all.remove(&monitor_id).unwrap_or_default())
}

/// Resolve links for several servers, omitting those with no links.
/// Returns `(count, servers)` where `servers` is keyed by server id.
///
/// A fixed handful of statements regardless of how many servers are asked
/// for (A7): the Superboard asks for every card at once, and resolving each
/// server with its own queries cost hundreds of round trips per refresh.
pub async fn for_many(pool: &SqlitePool, ids: &[i64]) -> Result<(i64, Value), ApiError> {
    let mut unique: Vec<i64> = Vec::with_capacity(ids.len());
    let mut seen: HashSet<i64> = HashSet::new();
    for id in ids {
        if seen.insert(*id) {
            unique.push(*id);
        }
    }

    let mut resolved = resolve_many(pool, &unique).await?;
    let mut servers = serde_json::Map::new();
    let mut count = 0i64;
    for id in &unique {
        if let Some((raw, targets)) = resolved.remove(id)
            && !raw.is_empty()
        {
            servers.insert(id.to_string(), json!({ "raw": raw, "resolved": targets }));
            count += 1;
        }
    }

    Ok((count, Value::Object(servers)))
}

/// The batched resolver behind [`resolve`] and [`for_many`]:
/// 1. every server's raw links in one `IN (…)` query;
/// 2. the monitor tree once, expanded in memory for group links;
/// 3. the latest heartbeat of every involved monitor in one statement;
/// 4. every resolved target's identity in one `IN (…)` query.
async fn resolve_many(
    pool: &SqlitePool,
    servers: &[i64],
) -> Result<HashMap<i64, Resolved>, ApiError> {
    let mut out: HashMap<i64, Resolved> = HashMap::new();
    if servers.is_empty() {
        return Ok(out);
    }

    // 1. Raw links, in link order per server. A stored link to a
    // non-website (possible before this rule existed: the picker used to
    // offer every monitor) is ignored rather than drawn as a website chip.
    // Group links stay, since a group is how a whole set of sites is linked
    // at once.
    let mut links: Vec<LinkRow> = Vec::new();
    for chunk in servers.chunks(IN_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT ml.monitor_id AS monitor_id, ml.linked_monitor_id AS linked_monitor_id,
                    m.name AS name, m.type AS type
             FROM monitor_links ml
             JOIN monitors m ON m.id = ml.linked_monitor_id
             WHERE ml.monitor_id IN ({placeholders})
             ORDER BY ml.monitor_id, ml.id"
        );
        let mut query = sqlx::query_as::<_, LinkRow>(sqlx::AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(id);
        }
        links.extend(query.fetch_all(pool).await.map_err(internal)?);
    }
    links.retain(|row| row.kind == "group" || is_website(&row.kind));

    // 2. The tree, only when some link is a group.
    let tree = if links.iter().any(|row| row.kind == "group") {
        Some(children_by_parent(pool).await?)
    } else {
        None
    };

    // Expand group links to concrete monitors, keeping link order and
    // dropping duplicates. The server can never link itself, even when one
    // of its own groups contains it.
    let mut by_server: HashMap<i64, Vec<&LinkRow>> = HashMap::new();
    for row in &links {
        by_server.entry(row.monitor_id).or_default().push(row);
    }
    let mut expanded: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    let mut involved: Vec<i64> = Vec::new();
    let mut involved_seen: HashSet<i64> = HashSet::new();
    for (server, rows) in &by_server {
        let mut seen: HashSet<i64> = HashSet::new();
        let mut targets: Vec<(i64, i64)> = Vec::new();
        for link in rows {
            if involved_seen.insert(link.linked_monitor_id) {
                involved.push(link.linked_monitor_id);
            }
            let candidates = match (&tree, link.kind == "group") {
                (Some(tree), true) => descendants(tree, link.linked_monitor_id),
                _ => vec![link.linked_monitor_id],
            };
            for id in candidates {
                if id == *server || !seen.insert(id) {
                    continue;
                }
                targets.push((id, link.linked_monitor_id));
                if involved_seen.insert(id) {
                    involved.push(id);
                }
            }
        }
        expanded.insert(*server, targets);
    }

    // 3 and 4.
    let beats = crate::status_pages::recent_beats(pool, &involved, 1)
        .await
        .map_err(internal)?;
    let latest = |id: i64| beats.get(&id).and_then(|list| list.first());
    let target_ids: Vec<i64> = {
        let mut ids: Vec<i64> = expanded
            .values()
            .flat_map(|targets| targets.iter().map(|(id, _)| *id))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let targets = load_targets(pool, &target_ids).await?;

    for server in servers {
        let raw_json: Vec<Value> = by_server
            .get(server)
            .map(|rows| {
                rows.iter()
                    .map(|row| {
                        let beat = latest(row.linked_monitor_id);
                        json!({
                            "linkedMonitorId": row.linked_monitor_id,
                            "name": row.name,
                            "type": row.kind,
                            "status": beat.map(|beat| beat.status).unwrap_or(PENDING),
                            "ping": beat.and_then(|beat| beat.ping),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let resolved: Vec<Value> = expanded
            .get(server)
            .map(|list| {
                list.iter()
                    .filter_map(|(id, via)| {
                        let target = targets.get(id)?;
                        let beat = latest(*id);
                        Some(json!({
                            "id": target.id,
                            "name": target.name,
                            "type": target.kind,
                            "status": beat.map(|beat| beat.status).unwrap_or(PENDING),
                            "ping": beat.and_then(|beat| beat.ping),
                            "url": target.url,
                            "lastCheck": beat.map(|beat| beat.time.clone()),
                            "via": via,
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default();

        out.insert(*server, (raw_json, resolved));
    }

    Ok(out)
}

/// Replace a server's links with exactly the supplied ids.
///
/// Non-positive ids, the server itself and duplicates are dropped; ids that
/// no longer exist are skipped, since the target may have been deleted
/// between the picker loading and the save. Ids that are neither a website
/// nor a group are skipped too, so storage never holds a link the board
/// would refuse to draw.
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
        let sql = format!(
            "SELECT id FROM monitors WHERE id IN ({placeholders})
             AND (type IN ('http', 'https') OR type = 'group')"
        );
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

/// Children of every monitor, ordered by id: the whole tree in one query.
/// Monitor counts are in the hundreds, so this is cheaper than a query per
/// level per group link.
async fn children_by_parent(
    pool: &SqlitePool,
) -> Result<HashMap<i64, Vec<(i64, String)>>, ApiError> {
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, type, parent FROM monitors WHERE parent IS NOT NULL ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .map_err(internal)?;
    let mut tree: HashMap<i64, Vec<(i64, String)>> = HashMap::new();
    for (id, kind, parent) in rows {
        tree.entry(parent).or_default().push((id, kind));
    }
    Ok(tree)
}

/// Every website id below a monitor, breadth-first and cycle-safe. Nested
/// groups are traversed; non-website leaves (servers, ping checks) are never
/// returned, so linking a mixed group links only the websites inside it.
/// Each level is visited in id order, as the per-level query used to.
fn descendants(tree: &HashMap<i64, Vec<(i64, String)>>, root: i64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut frontier = vec![root];

    while !frontier.is_empty() {
        let mut children: Vec<&(i64, String)> = frontier
            .iter()
            .filter_map(|parent| tree.get(parent))
            .flatten()
            .collect();
        children.sort_by_key(|(id, _)| *id);

        let mut next = Vec::new();
        for (id, kind) in children {
            if *id == root || !seen.insert(*id) {
                continue;
            }
            if is_website(kind) {
                out.push(*id);
            } else if kind == "group" {
                // Descend, but never list the group itself as a website.
                next.push(*id);
            }
        }
        frontier = next;
    }

    out
}

/// Identity of a set of monitors, in `IN (…)` chunks.
async fn load_targets(pool: &SqlitePool, ids: &[i64]) -> Result<HashMap<i64, TargetRow>, ApiError> {
    let mut targets = HashMap::new();
    for chunk in ids.chunks(IN_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT id, name, type, url FROM monitors WHERE id IN ({placeholders})");
        let mut query = sqlx::query_as::<_, TargetRow>(sqlx::AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(id);
        }
        for row in query.fetch_all(pool).await.map_err(internal)? {
            targets.insert(row.id, row);
        }
    }
    Ok(targets)
}

fn internal(e: sqlx::Error) -> ApiError {
    tracing::error!("links: {e}");
    ApiError::server()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pre-batching resolver, verbatim, kept as the oracle for A7.
    mod legacy {
        use super::super::{PENDING, internal, is_website};
        use crate::api::ApiError;
        use serde_json::{Value, json};
        use sqlx::SqlitePool;
        use std::collections::{HashMap, HashSet};

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
        pub async fn resolve(
            pool: &SqlitePool,
            monitor_id: i64,
        ) -> Result<(Vec<Value>, Vec<Value>), ApiError> {
            let raw = raw_links(pool, monitor_id).await?;
            // A stored link to a non-website (possible before this rule existed: the
            // picker used to offer every monitor) is ignored rather than drawn as a
            // website chip. Group links stay, since a group is how a whole set of
            // sites is linked at once.
            let raw: Vec<RawRow> = raw
                .into_iter()
                .filter(|row| row.kind == "group" || is_website(&row.kind))
                .collect();

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

        /// Every website id below a monitor, breadth-first and cycle-safe. Nested
        /// groups are traversed; non-website leaves (servers, ping checks) are never
        /// returned, so linking a mixed group links only the websites inside it.
        async fn descendants(pool: &SqlitePool, root: i64) -> Result<Vec<i64>, ApiError> {
            let mut out = Vec::new();
            let mut seen: HashSet<i64> = HashSet::new();
            let mut frontier = vec![root];

            while !frontier.is_empty() {
                let placeholders = vec!["?"; frontier.len()].join(",");
                let sql = format!(
                    "SELECT id, type FROM monitors WHERE parent IN ({placeholders}) ORDER BY id"
                );
                let mut query = sqlx::query_as::<_, (i64, String)>(sqlx::AssertSqlSafe(sql));
                for parent in &frontier {
                    query = query.bind(parent);
                }
                let children = query.fetch_all(pool).await.map_err(internal)?;

                let mut next = Vec::new();
                for (id, kind) in children {
                    if id == root || !seen.insert(id) {
                        continue;
                    }
                    if is_website(&kind) {
                        out.push(id);
                    } else if kind == "group" {
                        // Descend, but never list the group itself as a website.
                        next.push(id);
                    }
                }
                frontier = next;
            }

            Ok(out)
        }

        /// Load a set of monitors with their latest status in one query.
        async fn load_targets(
            pool: &SqlitePool,
            ids: &[i64],
        ) -> Result<HashMap<i64, TargetRow>, ApiError> {
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
    }

    async fn pool() -> SqlitePool {
        let dir = tempfile::tempdir().unwrap();
        crate::db::connect(&dir.keep()).await.unwrap()
    }

    async fn monitor(pool: &SqlitePool, name: &str, kind: &str, parent: Option<i64>) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO monitors (name, type, parent, url) VALUES (?, ?, ?, ?) RETURNING id",
        )
        .bind(name)
        .bind(kind)
        .bind(parent)
        .bind(format!("https://{name}.example"))
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn link(pool: &SqlitePool, server: i64, target: i64) {
        sqlx::query("INSERT INTO monitor_links (monitor_id, linked_monitor_id) VALUES (?, ?)")
            .bind(server)
            .bind(target)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn beat(pool: &SqlitePool, monitor: i64, time: &str, status: i64, ping: Option<f64>) {
        sqlx::query("INSERT INTO heartbeats (monitor_id, time, status, ping) VALUES (?, ?, ?, ?)")
            .bind(monitor)
            .bind(time)
            .bind(status)
            .bind(ping)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn batched_resolution_matches_the_per_server_resolver() {
        let pool = pool().await;

        // Tree: outer group > (site b, inner group > (site c, ping p), server s2)
        let outer = monitor(&pool, "outer", "group", None).await;
        let site_a = monitor(&pool, "a", "http", None).await;
        let site_b = monitor(&pool, "b", "https", Some(outer)).await;
        let inner = monitor(&pool, "inner", "group", Some(outer)).await;
        let site_c = monitor(&pool, "c", "http", Some(inner)).await;
        let ping = monitor(&pool, "p", "ping", Some(inner)).await;
        let s1 = monitor(&pool, "s1", "push", None).await;
        let s2 = monitor(&pool, "s2", "push", Some(outer)).await;
        let s3 = monitor(&pool, "s3", "push", None).await;
        let lonely = monitor(&pool, "lonely", "push", None).await;
        let site_d = monitor(&pool, "d", "http", Some(inner)).await;

        // s1: direct site, then the outer group (duplicate b via group), a
        // stale non-website link that must be ignored.
        link(&pool, s1, site_a).await;
        link(&pool, s1, site_b).await;
        link(&pool, s1, outer).await;
        link(&pool, s1, ping).await;
        // s2 sits inside the group it links: it must not link itself.
        link(&pool, s2, outer).await;
        link(&pool, s2, site_a).await;
        // s3 links only the inner group.
        link(&pool, s3, inner).await;

        for (id, offset) in [
            (site_a, 0),
            (site_b, 1),
            (site_c, 2),
            (site_d, 3),
            (inner, 4),
        ] {
            beat(&pool, id, "2026-10-20 09:00:00.000", 0, None).await;
            beat(
                &pool,
                id,
                &format!("2026-10-20 10:00:0{offset}.000"),
                1,
                Some(10.0 + offset as f64),
            )
            .await;
        }
        // Tie on time: the higher id wins, as in the subqueries.
        beat(&pool, site_a, "2026-10-20 10:00:00.000", 0, Some(99.0)).await;

        let ids = [s1, s2, s3, lonely, site_a, s1];
        let (count, servers) = for_many(&pool, &ids).await.unwrap();

        let mut expected = serde_json::Map::new();
        let mut expected_count = 0;
        for id in [s1, s2, s3, lonely, site_a] {
            let (raw, resolved) = legacy::resolve(&pool, id).await.unwrap();
            if !raw.is_empty() {
                expected.insert(id.to_string(), json!({ "raw": raw, "resolved": resolved }));
                expected_count += 1;
            }
        }
        assert_eq!(count, expected_count);
        assert_eq!(servers, Value::Object(expected));
        assert_eq!(count, 3, "s1, s2 and s3 have links");

        // Single-server resolution agrees too, including for no links.
        for id in [s1, s2, s3, lonely] {
            assert_eq!(
                resolve(&pool, id).await.unwrap(),
                legacy::resolve(&pool, id).await.unwrap()
            );
        }
    }
}
