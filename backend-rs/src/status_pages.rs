//! Status pages: read-only model, public JSON shapes and the password gate.
//!
//! The importer seeds these tables from the old database; the API serves the
//! deployed client pages (config, heartbeats, incidents, host mapping,
//! unlock). Authoring stays out of v1 — pages are frozen until a later pass.

use std::collections::HashMap;
use std::path::Path;

use axum::http::HeaderMap;
use rand::Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

/// Cookie holding a successful unlock.
pub const AUTH_COOKIE: &str = "fl_status_auth";
/// How long an unlock lasts, in seconds.
pub const UNLOCK_TTL_SECONDS: i64 = 60 * 60 * 12;
/// Incidents per history page.
pub const INCIDENT_PAGE_SIZE: i64 = 10;

/// One status page row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Page {
    pub id: i64,
    pub slug: String,
    pub title: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub theme: String,
    pub accent_color: Option<String>,
    pub auto_refresh_interval: Option<i64>,
    pub published: i64,
    pub show_tags: i64,
    pub custom_css: Option<String>,
    pub footer_text: Option<String>,
    pub show_powered_by: i64,
    pub analytics_id: Option<String>,
    pub analytics_script_url: Option<String>,
    pub analytics_type: Option<String>,
    pub show_certificate_expiry: i64,
    pub show_only_last_heartbeat: i64,
    pub rss_title: Option<String>,
    /// bcrypt hash imported from the old database; NULL means public.
    pub password: Option<String>,
}

/// Load a page by slug (case-insensitive, like every Node route).
///
/// Unfiltered: the public routes check [`Page::published`] themselves, so an
/// authenticated operator can still preview an unpublished page.
pub async fn load(pool: &SqlitePool, slug: &str) -> sqlx::Result<Option<Page>> {
    sqlx::query_as::<_, Page>("SELECT * FROM status_pages WHERE slug = ?")
        .bind(slug.to_lowercase())
        .fetch_optional(pool)
        .await
}

fn icon(page: &Page) -> String {
    match page.icon.as_deref() {
        Some(icon) if !icon.is_empty() => icon.to_string(),
        _ => "/icon.svg".to_string(),
    }
}

/// The public page config, matching the Node `toPublicJSON`.
pub fn config_json(page: &Page) -> Value {
    json!({
        "slug": page.slug,
        "title": page.title,
        "description": page.description,
        "icon": icon(page),
        "autoRefreshInterval": page.auto_refresh_interval,
        "theme": page.theme,
        "accentColor": page.accent_color,
        "published": page.published != 0,
        "showTags": page.show_tags != 0,
        "customCSS": page.custom_css,
        "footerText": page.footer_text,
        "showPoweredBy": page.show_powered_by != 0,
        "analyticsId": page.analytics_id,
        "analyticsScriptUrl": page.analytics_script_url,
        "analyticsType": page.analytics_type,
        "showCertificateExpiry": page.show_certificate_expiry != 0,
        "showOnlyLastHeartbeat": page.show_only_last_heartbeat != 0,
        "rssTitle": page.rss_title,
    })
}

fn incident_json(row: &IncidentRow) -> Value {
    json!({
        "id": row.id,
        "style": row.style,
        "title": row.title,
        "content": row.content,
        "pin": row.pin != 0,
        "active": row.active != 0,
        "createdDate": row.created_date,
        "lastUpdatedDate": row.last_updated_date,
        "status_page_id": row.status_page_id,
    })
}

#[derive(sqlx::FromRow)]
struct IncidentRow {
    id: i64,
    status_page_id: i64,
    style: String,
    title: String,
    content: String,
    pin: i64,
    active: i64,
    created_date: String,
    last_updated_date: Option<String>,
}

/// One monitor on a public group, with the group-level overrides.
#[derive(sqlx::FromRow)]
struct GroupMonitorRow {
    id: i64,
    name: String,
    #[sqlx(rename = "type")]
    kind: String,
    url: Option<String>,
    send_url: i64,
    custom_url: Option<String>,
    #[allow(dead_code)]
    weight: i64,
}

/// `{config, incidents, publicGroupList, maintenanceList}` — the status page
/// data endpoint. Maintenance is out of scope in v1, so the list is always
/// empty.
pub async fn page_data(pool: &SqlitePool, page: &Page) -> sqlx::Result<Value> {
    let incidents: Vec<IncidentRow> = sqlx::query_as(
        "SELECT * FROM status_page_incidents
         WHERE status_page_id = ? AND pin = 1 AND active = 1
         ORDER BY created_date DESC",
    )
    .bind(page.id)
    .fetch_all(pool)
    .await?;

    let groups: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, name, weight FROM status_page_groups
         WHERE status_page_id = ? AND public = 1 ORDER BY weight",
    )
    .bind(page.id)
    .fetch_all(pool)
    .await?;

    // Every public group's monitors in one query, split per group in memory
    // (previously one query per group).
    let rows: Vec<(i64, GroupMonitorRow)> = {
        #[derive(sqlx::FromRow)]
        struct Row {
            group_id: i64,
            #[sqlx(flatten)]
            monitor: GroupMonitorRow,
        }
        sqlx::query_as::<_, Row>(
            "SELECT spm.group_id AS group_id, m.id, m.name, m.type, m.url,
                    spm.send_url, spm.custom_url, spm.weight
             FROM status_page_monitors spm
             JOIN status_page_groups g ON g.id = spm.group_id
             JOIN monitors m ON m.id = spm.monitor_id
             WHERE g.status_page_id = ? AND g.public = 1
             ORDER BY spm.group_id, spm.weight",
        )
        .bind(page.id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| (row.group_id, row.monitor))
        .collect()
    };
    let mut by_group: HashMap<i64, Vec<GroupMonitorRow>> = HashMap::new();
    for (group_id, monitor) in rows {
        by_group.entry(group_id).or_default().push(monitor);
    }

    let mut public_groups = Vec::new();
    for (group_id, name, weight) in groups {
        let monitors = by_group.remove(&group_id).unwrap_or_default();

        let monitor_list: Vec<Value> = monitors
            .into_iter()
            .map(|row| {
                let mut monitor = json!({
                    "id": row.id,
                    "name": row.name,
                    "sendUrl": row.send_url != 0,
                    "type": row.kind,
                });
                if row.send_url != 0 {
                    monitor["url"] = json!(row.custom_url.or(row.url));
                }
                monitor
            })
            .collect();

        public_groups.push(json!({
            "id": group_id,
            "name": name,
            "weight": weight,
            "monitorList": monitor_list,
        }));
    }

    let domains: Vec<String> = sqlx::query_scalar(
        "SELECT domain FROM status_page_cnames WHERE status_page_id = ? ORDER BY domain",
    )
    .bind(page.id)
    .fetch_all(pool)
    .await?;

    let mut config = config_json(page);
    // Node exposes the page's CNAMEs inside the config; consumers use it to
    // show alternate URLs.
    config["domainNameList"] = json!(domains);

    Ok(json!({
        "config": config,
        "incidents": incidents.iter().map(incident_json).collect::<Vec<_>>(),
        "publicGroupList": public_groups,
        "maintenanceList": [],
    }))
}

/// One heartbeat as the public surfaces show it.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct RecentBeat {
    pub id: i64,
    pub monitor_id: i64,
    pub time: String,
    pub status: i64,
    pub ping: Option<f64>,
}

/// Compound-select terms per statement; SQLite caps a compound SELECT at
/// 500 terms by default.
const BEAT_TERMS_PER_STATEMENT: usize = 200;

/// The newest `per_monitor` heartbeats of each monitor, newest first, in one
/// statement per 200 monitors.
///
/// Each monitor is its own `UNION ALL` term so every term walks the
/// `(monitor_id, time DESC)` index and stops after `per_monitor` rows; a
/// window-function ranking would read each monitor's whole history.
pub async fn recent_beats(
    pool: &SqlitePool,
    ids: &[i64],
    per_monitor: i64,
) -> sqlx::Result<HashMap<i64, Vec<RecentBeat>>> {
    let mut out: HashMap<i64, Vec<RecentBeat>> = HashMap::new();
    let mut unique: Vec<i64> = Vec::with_capacity(ids.len());
    for id in ids {
        if !unique.contains(id) {
            unique.push(*id);
        }
    }

    for chunk in unique.chunks(BEAT_TERMS_PER_STATEMENT) {
        // Dynamic only in statement count; values are bound.
        let sql = vec![
            "SELECT * FROM (SELECT id, monitor_id, time, status, ping FROM heartbeats \
             WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?)";
            chunk.len()
        ]
        .join(" UNION ALL ");
        let mut query = sqlx::query_as::<_, RecentBeat>(sqlx::AssertSqlSafe(sql));
        for id in chunk {
            query = query.bind(id).bind(per_monitor);
        }
        for beat in query.fetch_all(pool).await? {
            out.entry(beat.monitor_id).or_default().push(beat);
        }
    }

    // A compound select does not promise term order; restore it.
    for beats in out.values_mut() {
        beats.sort_by(|a, b| b.time.cmp(&a.time).then(b.id.cmp(&a.id)));
    }
    Ok(out)
}

/// Monitor ids on the page's public groups.
pub async fn public_monitor_ids(pool: &SqlitePool, page_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT spm.monitor_id FROM status_page_monitors spm
         JOIN status_page_groups g ON g.id = spm.group_id
         WHERE g.status_page_id = ? AND g.public = 1",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await
}

/// `{heartbeatList, uptimeList}` — the polling endpoint. Beats are public
/// JSON (messages hidden), oldest first, capped at 100 per monitor.
///
/// The beats come from one batched statement; the 24h uptime comes from
/// the engine's uptime cache instead of a window-function scan per monitor
/// per poll.
pub async fn heartbeat_data(
    pool: &SqlitePool,
    engine: &std::sync::Arc<crate::monitors::engine::Engine>,
    page: &Page,
) -> sqlx::Result<Value> {
    let ids = public_monitor_ids(pool, page.id).await?;
    let mut beats = recent_beats(pool, &ids, 100).await?;

    let mut heartbeat_list = serde_json::Map::new();
    let mut uptime_list = serde_json::Map::new();
    for monitor_id in ids {
        if heartbeat_list.contains_key(&monitor_id.to_string()) {
            continue;
        }
        let list: Vec<Value> = beats
            .remove(&monitor_id)
            .unwrap_or_default()
            .into_iter()
            .rev()
            .map(|beat| {
                json!({ "status": beat.status, "time": beat.time, "msg": "", "ping": beat.ping })
            })
            .collect();
        let uptime = engine.uptime_windows(monitor_id).await.day.unwrap_or(0.0);

        heartbeat_list.insert(monitor_id.to_string(), json!(list));
        uptime_list.insert(format!("{monitor_id}_24"), json!(uptime));
    }

    Ok(json!({
        "heartbeatList": heartbeat_list,
        "uptimeList": uptime_list,
    }))
}

/// Paginated incident history, cursor-based like the Node model.
pub async fn incident_history(
    pool: &SqlitePool,
    page_id: i64,
    cursor: Option<&str>,
) -> sqlx::Result<Value> {
    let incidents: Vec<IncidentRow> = match cursor {
        Some(cursor) if !cursor.is_empty() => {
            sqlx::query_as(
                "SELECT * FROM status_page_incidents
                 WHERE status_page_id = ? AND created_date < ?
                 ORDER BY created_date DESC LIMIT ?",
            )
            .bind(page_id)
            .bind(cursor)
            .bind(INCIDENT_PAGE_SIZE)
            .fetch_all(pool)
            .await?
        }
        _ => {
            sqlx::query_as(
                "SELECT * FROM status_page_incidents
                 WHERE status_page_id = ? ORDER BY created_date DESC LIMIT ?",
            )
            .bind(page_id)
            .bind(INCIDENT_PAGE_SIZE)
            .fetch_all(pool)
            .await?
        }
    };

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM status_page_incidents WHERE status_page_id = ?")
            .bind(page_id)
            .fetch_one(pool)
            .await?;

    let mut next_cursor: Option<String> = None;
    let mut has_more = false;
    if let Some(last) = incidents.last() {
        let older: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM status_page_incidents
             WHERE status_page_id = ? AND created_date < ?",
        )
        .bind(page_id)
        .bind(&last.created_date)
        .fetch_one(pool)
        .await?;
        has_more = older > 0;
        if has_more {
            next_cursor = Some(last.created_date.clone());
        }
    }

    Ok(json!({
        "ok": true,
        "incidents": incidents.iter().map(incident_json).collect::<Vec<_>>(),
        "total": total,
        "nextCursor": next_cursor,
        "hasMore": has_more,
    }))
}

/// Resolve a hostname to a page slug from the imported CNAME map.
///
/// `Ok(None)` means the host is genuinely unmapped; a database error is an
/// `Err`, never "no match" — the dashboard falls back to the operator view
/// on an unmapped host and retries on an error (A15).
pub async fn resolve_host(pool: &SqlitePool, host: &str) -> sqlx::Result<Option<String>> {
    let host = host.trim().to_lowercase();
    let host = host.split(':').next().unwrap_or("").to_string();
    if host.is_empty() {
        return Ok(None);
    }
    // Unpublished pages are not resolvable: the host falls back to the
    // dashboard rather than to a page the public may not see (A14).
    sqlx::query_scalar(
        "SELECT p.slug FROM status_page_cnames c
         JOIN status_pages p ON p.id = c.status_page_id
         WHERE c.domain = ? AND p.published = 1",
    )
    .bind(host)
    .fetch_optional(pool)
    .await
}

// ---------------------------------------------------------------------------
// Password gate
// ---------------------------------------------------------------------------

/// Read (or mint) the install-wide cookie signing secret. Stored beside the
/// database, owner-only, like the initial token file.
pub fn ensure_secret(data_dir: &Path) -> std::io::Result<String> {
    let path = data_dir.join("status-page-secret");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let secret = hex::encode(bytes);
    std::fs::write(&path, format!("{secret}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(secret)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    hex::encode(outer.finalize())
}

/// `<expiresAt>.<signature>` — the Node cookie value.
pub fn sign_unlock(secret: &str, slug: &str, expires_at: i64) -> String {
    let signature = hmac_sha256(secret.as_bytes(), format!("{slug}:{expires_at}").as_bytes());
    format!("{expires_at}.{signature}")
}

/// Verify an unlock cookie value for a page.
pub fn verify_unlock(secret: &str, cookie_value: &str, slug: &str) -> bool {
    let Some((expires, signature)) = cookie_value.split_once('.') else {
        return false;
    };
    let Ok(expires_at) = expires.parse::<i64>() else {
        return false;
    };
    if expires_at * 1000 < chrono::Utc::now().timestamp_millis() {
        return false;
    }
    let expected = hmac_sha256(secret.as_bytes(), format!("{slug}:{expires_at}").as_bytes());
    constant_time_eq(signature.as_bytes(), expected.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Parse a Cookie header into a plain map.
pub fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(header) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
    else {
        return out;
    };
    for part in header.split(';') {
        if let Some((key, value)) = part.split_once('=') {
            let key = key.trim();
            if !key.is_empty() {
                out.insert(key.to_string(), value.trim().to_string());
            }
        }
    }
    out
}

/// Whether a request may see this page: public pages always, protected ones
/// only with a valid unlock cookie.
pub fn is_unlocked(secret: &str, headers: &HeaderMap, page: &Page) -> bool {
    match page.password.as_deref() {
        None | Some("") => true,
        Some(_) => {
            let cookies = parse_cookies(headers);
            match cookies.get(AUTH_COOKIE) {
                Some(value) => verify_unlock(secret, value, &page.slug),
                None => false,
            }
        }
    }
}

/// The standalone prompt shown for form posts, mirroring the Node HTML.
pub fn render_password_prompt(slug: &str, error: Option<&str>) -> String {
    let escaped_slug = xml_escape(slug);
    let banner = match error {
        Some(message) => format!(
            "<p style=\"margin:0 0 16px;padding:10px 12px;border-radius:8px;background:rgba(229,72,77,.12);color:#e5484d;font-size:14px\">{}</p>",
            xml_escape(message)
        ),
        None => String::new(),
    };

    format!(
        "<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\" />
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
<meta name=\"robots\" content=\"noindex, nofollow, noarchive, nosnippet, noimageindex\" />
<title>Status page</title>
<style>
  :root {{ color-scheme: dark light; }}
  body {{
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #111113; color: #f2efea;
    font-family: ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;
  }}
  form {{
    width: 100%; max-width: 360px; padding: 28px;
    border: 1px solid #26262a; border-radius: 14px; background: #161618;
  }}
  h1 {{ margin: 0 0 4px; font-size: 19px; font-weight: 600; }}
  p.sub {{ margin: 0 0 20px; font-size: 13px; color: #938c87; }}
  input {{
    width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 14px;
    font-size: 15px; color: #f2efea; background: #0b0b0d;
    border: 1px solid #26262a; border-radius: 8px;
  }}
  input:focus {{ outline: 2px solid #ff4d2e; outline-offset: 1px; }}
  button {{
    width: 100%; padding: 10px 12px; font-size: 15px; font-weight: 600;
    color: #fff; background: #ff4d2e; border: 0; border-radius: 8px; cursor: pointer;
  }}
  button:hover {{ background: #ff6a4f; }}
</style>
</head>
<body>
<form method=\"post\" action=\"/api/v1/status-pages/unlock/{escaped_slug}\">
  <h1>This status page is private</h1>
  <p class=\"sub\">Enter the password you were given.</p>
  {banner}
  <input type=\"password\" name=\"password\" placeholder=\"Password\" autocomplete=\"current-password\" autofocus required />
  <button type=\"submit\">Unlock</button>
</form>
</body>
</html>"
    )
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_signature_round_trips_and_expires() {
        let secret = "test-secret";
        let now = chrono::Utc::now().timestamp();
        let value = sign_unlock(secret, "clients", now + 3600);
        assert!(verify_unlock(secret, &value, "clients"));
        // Wrong slug, wrong secret and tampered expiry all fail.
        assert!(!verify_unlock(secret, &value, "other"));
        assert!(!verify_unlock("other-secret", &value, "clients"));
        let expired = sign_unlock(secret, "clients", now - 10);
        assert!(!verify_unlock(secret, &expired, "clients"));
        assert!(!verify_unlock(secret, "garbage", "clients"));
        assert!(!verify_unlock(secret, "123.", "clients"));
    }

    #[test]
    fn hmac_matches_a_known_vector() {
        // RFC 4231 test case 2.
        assert_eq!(
            hmac_sha256(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn cookie_parsing_tolerates_noise() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "a=1; fl_status_auth=123.abc; broken".parse().unwrap(),
        );
        let cookies = parse_cookies(&headers);
        assert_eq!(
            cookies.get("fl_status_auth").map(String::as_str),
            Some("123.abc")
        );
        assert_eq!(cookies.get("a").map(String::as_str), Some("1"));
    }

    #[test]
    fn secret_is_created_once_with_owner_only_mode() {
        let dir = tempfile::tempdir().unwrap();
        let first = ensure_secret(dir.path()).unwrap();
        let second = ensure_secret(dir.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("status-page-secret"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
