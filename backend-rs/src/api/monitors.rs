//! Monitor CRUD handlers.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::AppState;
use crate::api::ApiError;
use crate::heartbeats::Beat;
use crate::mutes;
use crate::monitors::{
    Monitor, TYPES, apply_interval_defaults, apply_payload, generate_push_token, monitor_json,
    validate_parent,
};

/// Query parameters shared by list.
#[derive(Debug, Default, serde::Deserialize)]
pub struct ListQuery {
    page: Option<String>,
    #[serde(rename = "perPage")]
    per_page: Option<String>,
    status: Option<String>,
    active: Option<String>,
    q: Option<String>,
}

/// A bound parameter, because filters vary.
enum Param {
    Int(i64),
    Text(String),
}

/// Parse pagination exactly like the Node backend: integers, page >= 1,
/// perPage capped at 200, defaults 1 and 50.
fn pagination(query: &ListQuery) -> Result<(i64, i64, i64, i64), ApiError> {
    let page = match &query.page {
        Some(raw) => {
            let value: i64 = raw
                .parse()
                .ok()
                .filter(|n| *n >= 1)
                .ok_or_else(|| ApiError::bad("`page` must be an integer of 1 or greater."))?;
            value
        }
        None => 1,
    };

    let per_page = match &query.per_page {
        Some(raw) => {
            let value: i64 =
                raw.parse().ok().filter(|n| *n >= 1).ok_or_else(|| {
                    ApiError::bad("`perPage` must be an integer of 1 or greater.")
                })?;
            value.min(200)
        }
        None => 50,
    };

    Ok((page, per_page, per_page, (page - 1) * per_page))
}

/// Build the shared WHERE clause for list/count.
fn filters(query: &ListQuery) -> Result<(String, Vec<Param>), ApiError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Param> = Vec::new();

    if let Some(active) = &query.active {
        match active.as_str() {
            "true" => {
                clauses.push("active = ?".to_string());
                params.push(Param::Int(1));
            }
            "false" => {
                clauses.push("active = ?".to_string());
                params.push(Param::Int(0));
            }
            _ => return Err(ApiError::bad("`active` must be true or false.")),
        }
    }

    if let Some(q) = &query.q {
        let like = format!("%{}%", q.chars().take(100).collect::<String>());
        clauses.push("(name LIKE ? OR url LIKE ?)".to_string());
        params.push(Param::Text(like.clone()));
        params.push(Param::Text(like));
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    Ok((where_sql, params))
}

/// Fetch the latest heartbeat for each monitor id in one query.
///
/// Each monitor is asked for its own newest row through the
/// `(monitor_id, time DESC)` index (`ORDER BY time DESC, id DESC LIMIT 1`),
/// unioned into one statement. The previous ROW_NUMBER() ranking had to
/// read and rank every heartbeat of every requested monitor — work
/// proportional to the stored history — to keep one row per monitor; the
/// audit measured 88ms versus 0.19ms on a 100k-row fixture.
async fn latest_beats(
    pool: &SqlitePool,
    ids: &[i64],
) -> Result<std::collections::HashMap<i64, Beat>, ApiError> {
    let mut beats = std::collections::HashMap::new();
    if ids.is_empty() {
        return Ok(beats);
    }

    // Dynamic only in statement count; ids are bound, never interpolated.
    // Each term is a FROM-clause subquery so its LIMIT stays inside the
    // term (SQLite rejects ORDER BY/LIMIT directly before UNION ALL).
    let mut unique: Vec<i64> = Vec::with_capacity(ids.len());
    for id in ids {
        if !unique.contains(id) {
            unique.push(*id);
        }
    }
    let mut terms: Vec<String> = Vec::with_capacity(unique.len());
    for _ in 0..unique.len() {
        terms.push(
            "SELECT * FROM (SELECT * FROM heartbeats WHERE monitor_id = ? \
             ORDER BY time DESC, id DESC LIMIT 1)"
                .to_string(),
        );
    }
    let sql = terms.join(" UNION ALL ");

    let mut query = sqlx::query_as::<_, Beat>(sqlx::AssertSqlSafe(sql));
    for id in &unique {
        query = query.bind(id);
    }

    for row in query.fetch_all(pool).await.map_err(internal)? {
        beats.insert(row.monitor_id, row);
    }

    Ok(beats)
}

/// Uptime lookups run this many at a time: enough to overlap the cold
/// 30-day scans after a restart, few enough to leave pool connections for
/// the check loops (the pool has five).
const UPTIME_CONCURRENCY: usize = 3;

/// Uptime windows for a page of monitors through the engine's cache.
///
/// Warm entries are memory reads. After a restart every entry is cold and
/// the engine computes it inline, so the lookups are overlapped in small
/// batches instead of running one monitor after another (A13).
async fn uptime_windows_for(
    engine: &std::sync::Arc<crate::monitors::engine::Engine>,
    ids: &[i64],
) -> std::collections::HashMap<i64, crate::heartbeats::UptimeWindows> {
    let mut out = std::collections::HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(UPTIME_CONCURRENCY) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|&id| {
                let engine = std::sync::Arc::clone(engine);
                (
                    id,
                    tokio::spawn(async move { engine.uptime_windows(id).await }),
                )
            })
            .collect();
        for (id, handle) in handles {
            out.insert(id, handle.await.unwrap_or_default());
        }
    }
    out
}

/// GET /api/v1/monitors
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let (page, per_page, limit, offset) = pagination(&query)?;
    let (where_sql, params) = filters(&query)?;

    let count_sql = format!("SELECT COUNT(*) FROM monitors{where_sql}");
    // Dynamic only in fixed clauses; filter values are bound.
    let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql));
    for param in &params {
        count_query = match param {
            Param::Int(n) => count_query.bind(n),
            Param::Text(s) => count_query.bind(s),
        };
    }
    let total = count_query.fetch_one(&state.pool).await.map_err(internal)?;

    let list_sql = format!("SELECT * FROM monitors{where_sql} ORDER BY id LIMIT ? OFFSET ?");
    let mut list_query = sqlx::query_as::<_, Monitor>(sqlx::AssertSqlSafe(list_sql));
    for param in &params {
        list_query = match param {
            Param::Int(n) => list_query.bind(n),
            Param::Text(s) => list_query.bind(s),
        };
    }
    let monitors = list_query
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(internal)?;

    let ids: Vec<i64> = monitors.iter().map(|m| m.id).collect();
    let beats = latest_beats(&state.pool, &ids).await?;

    let uptimes = uptime_windows_for(&state.engine, &ids).await;
    let coverage = mutes::coverage(&state.pool).await.map_err(internal)?;

    let mut result = Vec::with_capacity(monitors.len());
    for monitor in &monitors {
        let uptime = uptimes.get(&monitor.id).copied().unwrap_or_default();
        let mut object = monitor_json(monitor, beats.get(&monitor.id), &uptime);
        with_mute(&mut object, &coverage, monitor.id);
        // Status filtering happens after resolution, like the Node backend:
        // it depends on the latest heartbeat, not a column.
        if let Some(wanted) = &query.status {
            let actual = object.get("status").and_then(Value::as_i64);
            let matches = match wanted.as_str() {
                "up" => actual == Some(1),
                "down" => actual == Some(0),
                "pending" => actual == Some(2),
                "maintenance" => actual == Some(3),
                _ => true,
            };
            if !matches {
                continue;
            }
        }
        result.push(object);
    }

    let total_pages = if total == 0 {
        0
    } else {
        (total + per_page - 1) / per_page
    };

    Ok(Json(json!({
        "ok": true,
        "count": result.len(),
        "monitors": result,
        "pagination": {
            "page": page,
            "perPage": per_page,
            "total": total,
            "totalPages": total_pages,
            "hasMore": page * per_page < total,
        }
    })))
}

/// Load one monitor or answer 404.
pub(crate) async fn load(pool: &SqlitePool, id: i64) -> Result<Monitor, ApiError> {
    sqlx::query_as::<_, Monitor>("SELECT * FROM monitors WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found(format!("No monitor with id {id}.")))
}

/// GET /api/v1/monitors/{id}
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let monitor = load(&state.pool, id).await?;
    let beats = latest_beats(&state.pool, &[id]).await?;
    let uptime = state.engine.uptime_windows(id).await;
    let coverage = mutes::coverage(&state.pool).await.map_err(internal)?;
    let mut object = monitor_json(&monitor, beats.get(&id), &uptime);
    with_mute(&mut object, &coverage, id);
    Ok(Json(json!({
        "ok": true,
        "monitor": object,
    })))
}

/// Add the mute fields to a monitor object: `mute`, the monitor's own mute
/// as a subject (or null), and `mutedBy`, the subjects whose mute covers it.
fn with_mute(object: &mut Value, coverage: &mutes::Coverage, id: i64) {
    if let Some(map) = object.as_object_mut() {
        map.insert(
            "mute".to_string(),
            coverage
                .mutes
                .get(&id)
                .map_or(Value::Null, mutes::Mute::to_json),
        );
        map.insert(
            "mutedBy".to_string(),
            json!(coverage.muted_by.get(&id).cloned().unwrap_or_default()),
        );
    }
}

/// POST /api/v1/monitors/{id}/mute
///
/// Mute a known outage: snapshot what is down on the monitor (itself and the
/// websites linked to it) and the disk problems its latest sample reports.
/// The board shows it dark red and Telegram stops repeating it until
/// something new breaks or everything recovers. Muting again replaces the
/// snapshot.
pub async fn mute(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let monitor = load(&state.pool, id).await?;
    let sample = match state.metrics.sample(id) {
        Some((_, sample)) => Some(sample),
        None => crate::metrics::ingest::load_latest(&state.pool, id)
            .await
            .map(|(_, sample)| sample),
    };
    let mute = match mutes::mute(&state.pool, id, sample.as_ref(), monitor.metric_disk_threshold).await {
        Ok(mute) => mute,
        Err(mutes::MuteError::NotFound) => {
            return Err(ApiError::not_found(format!("No monitor with id {id}.")));
        }
        Err(mutes::MuteError::NothingDown) => {
            return Err(ApiError::bad(
                "Nothing on this monitor is down, so there is nothing to mute.",
            ));
        }
        Err(mutes::MuteError::Db(error)) => return Err(internal(error)),
    };
    state.events.invalidate();
    Ok(Json(json!({ "ok": true, "id": id, "mute": mute.to_json() })))
}

/// DELETE /api/v1/monitors/{id}/mute
///
/// Unmute: delete the monitor's own mute and every mute covering it (for a
/// group, every mute covering a monitor inside it). Idempotent.
pub async fn unmute(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;
    let unmuted = mutes::unmute(&state.pool, id).await.map_err(internal)?;
    if !unmuted.is_empty() {
        state.events.invalidate();
    }
    Ok(Json(json!({ "ok": true, "id": id, "unmuted": unmuted })))
}

/// GET /api/v1/monitors/{id}/heartbeats
///
/// Recent heartbeats, newest first. High-volume, so a plain `limit`
/// (default 100, capped at 1000) plus the true total — Node parity.
pub async fn heartbeats(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let monitor = load(&state.pool, id).await?;

    let limit = match params.get("limit") {
        Some(raw) => {
            if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
                return Err(ApiError::bad("limit must be a positive integer."));
            }
            raw.parse::<i64>().unwrap_or(100).min(1000)
        }
        None => 100,
    };

    // `time DESC, id DESC` walks the `(monitor_id, time DESC)` index and
    // stops after `limit` rows; `ORDER BY id DESC` sorted the monitor's whole
    // history in a temp B-tree on every call.
    let rows: Vec<Beat> = sqlx::query_as(
        "SELECT * FROM heartbeats WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?",
    )
    .bind(monitor.id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;

    // A short page is the whole history, so the total is free; only a full
    // page needs the count (a covering-index range scan, no table reads).
    let total: i64 = if (rows.len() as i64) < limit {
        rows.len() as i64
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM heartbeats WHERE monitor_id = ?")
            .bind(monitor.id)
            .fetch_one(&state.pool)
            .await
            .map_err(internal)?
    };

    let heartbeats: Vec<Value> = rows
        .iter()
        .map(|beat| {
            json!({
                "time": beat.time,
                "status": beat.status,
                "ping": beat.ping,
                "msg": beat.msg,
                "important": beat.important != 0,
            })
        })
        .collect();

    Ok(Json(json!({
        "ok": true,
        "monitorId": monitor.id,
        "count": heartbeats.len(),
        "heartbeats": heartbeats,
        "total": total,
        "limit": limit,
    })))
}

/// POST /api/v1/monitors
pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let payload = body
        .as_object()
        .ok_or_else(|| ApiError::bad("body must be a JSON object"))?;

    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad("`name` is required."))?
        .to_string();

    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad("`type` is required. See GET /api/v1/monitor-types."))?
        .to_string();

    if !TYPES.contains(&kind.as_str()) {
        return Err(ApiError::bad(format!(
            "Unknown monitor type \"{kind}\". See GET /api/v1/monitor-types."
        )));
    }

    let mut monitor = Monitor::new(name, kind);
    let ignored = apply_payload(&mut monitor, payload, true)?;
    apply_interval_defaults(&mut monitor, payload);

    if monitor.kind == "push" && monitor.push_token.is_none() {
        monitor.push_token = Some(generate_push_token());
    }
    if matches!(monitor.kind.as_str(), "http" | "https") && monitor.url.is_none() {
        return Err(ApiError::bad("`url` is required for http monitors."));
    }
    if monitor.kind == "ping" && monitor.hostname.is_none() {
        return Err(ApiError::bad("`hostname` is required for ping monitors."));
    }

    validate_parent(&state.pool, None, monitor.parent).await?;

    let stored = sqlx::query_as::<_, Monitor>(
        "INSERT INTO monitors (
            name, type, active, description, interval, retry_interval, maxretries,
            timeout, resend_interval, upside_down, parent, weight, provider, url, method,
            accepted_statuscodes, ignore_tls, maxredirects, push_token,
            hostname, packet_size, ping_count, ping_numeric, ping_per_request_timeout,
            metric_cpu_threshold, metric_ram_threshold, metric_disk_threshold
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
    )
    .bind(&monitor.name)
    .bind(&monitor.kind)
    .bind(monitor.active)
    .bind(&monitor.description)
    .bind(monitor.interval)
    .bind(monitor.retry_interval)
    .bind(monitor.maxretries)
    .bind(monitor.timeout)
    .bind(monitor.resend_interval)
    .bind(monitor.upside_down)
    .bind(monitor.parent)
    .bind(monitor.weight)
    .bind(&monitor.provider)
    .bind(&monitor.url)
    .bind(&monitor.method)
    .bind(&monitor.accepted_statuscodes)
    .bind(monitor.ignore_tls)
    .bind(monitor.maxredirects)
    .bind(&monitor.push_token)
    .bind(&monitor.hostname)
    .bind(monitor.packet_size)
    .bind(monitor.ping_count)
    .bind(monitor.ping_numeric)
    .bind(monitor.ping_per_request_timeout)
    .bind(monitor.metric_cpu_threshold)
    .bind(monitor.metric_ram_threshold)
    .bind(monitor.metric_disk_threshold)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;

    state.events.invalidate();
    if let Some(list) = payload.get("notificationIDList") {
        apply_notification_links(&state.pool, stored.id, list).await?;
    }
    state.engine.restart(stored.id).await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "monitor": monitor_json(&stored, None, &crate::heartbeats::UptimeWindows::default()),
            "ignoredFields": ignored,
        })),
    ))
}

/// PATCH /api/v1/monitors/{id}
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let payload = body
        .as_object()
        .ok_or_else(|| ApiError::bad("body must be a JSON object"))?;

    let mut monitor = load(&state.pool, id).await?;

    if let Some(kind) = payload.get("type").and_then(Value::as_str)
        && kind != monitor.kind
    {
        return Err(ApiError::bad(
            "Monitor `type` cannot be changed after creation.",
        ));
    }

    let ignored = apply_payload(&mut monitor, payload, false)?;
    apply_interval_defaults(&mut monitor, payload);
    validate_parent(&state.pool, Some(id), monitor.parent).await?;

    let stored = sqlx::query_as::<_, Monitor>(
        "UPDATE monitors SET
            name = ?, active = ?, description = ?, interval = ?, retry_interval = ?,
            maxretries = ?, timeout = ?, resend_interval = ?, upside_down = ?, parent = ?,
            weight = ?, provider = ?, url = ?, method = ?, accepted_statuscodes = ?, ignore_tls = ?,
            maxredirects = ?, push_token = ?, hostname = ?, packet_size = ?, ping_count = ?,
            ping_numeric = ?, ping_per_request_timeout = ?, metric_cpu_threshold = ?,
            metric_ram_threshold = ?, metric_disk_threshold = ?
         WHERE id = ? RETURNING *",
    )
    .bind(&monitor.name)
    .bind(monitor.active)
    .bind(&monitor.description)
    .bind(monitor.interval)
    .bind(monitor.retry_interval)
    .bind(monitor.maxretries)
    .bind(monitor.timeout)
    .bind(monitor.resend_interval)
    .bind(monitor.upside_down)
    .bind(monitor.parent)
    .bind(monitor.weight)
    .bind(&monitor.provider)
    .bind(&monitor.url)
    .bind(&monitor.method)
    .bind(&monitor.accepted_statuscodes)
    .bind(monitor.ignore_tls)
    .bind(monitor.maxredirects)
    .bind(&monitor.push_token)
    .bind(&monitor.hostname)
    .bind(monitor.packet_size)
    .bind(monitor.ping_count)
    .bind(monitor.ping_numeric)
    .bind(monitor.ping_per_request_timeout)
    .bind(monitor.metric_cpu_threshold)
    .bind(monitor.metric_ram_threshold)
    .bind(monitor.metric_disk_threshold)
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;

    state.events.invalidate();
    if let Some(list) = payload.get("notificationIDList") {
        apply_notification_links(&state.pool, id, list).await?;
    }
    state.engine.restart(id).await;

    let beats = latest_beats(&state.pool, &[id]).await?;
    let uptime = state.engine.uptime_windows(id).await;

    Ok(Json(json!({
        "ok": true,
        "monitor": monitor_json(&stored, beats.get(&id), &uptime),
        "ignoredFields": ignored,
    })))
}

/// The newest agent self-report for a monitor: the live cache when it has a
/// sample, else the newest archived row. Shared by the clear endpoints, which
/// acknowledge whatever the agent is reporting right now.
async fn latest_agent(state: &AppState, id: i64) -> Option<Value> {
    if let Some(agent) = state
        .metrics
        .latest_json(id)
        .and_then(|sample| sample.pointer("/metrics/agent").cloned())
    {
        return Some(agent);
    }
    crate::metrics::ingest::load_latest(&state.pool, id)
        .await
        .and_then(|(_, sample)| sample.pointer("/agent").cloned())
}

/// POST /api/v1/monitors/{id}/push-failures/clear
///
/// Acknowledge the agent's current `failedPushes` counter. The board shows
/// `failedPushes - pushFailuresAck`, so this clears the visible failures
/// without touching the agent (there is no server-to-agent channel). The
/// counter resets when the agent restarts; ingest drops the ack when it
/// sees the counter move backwards, so new failures are never masked.
pub async fn clear_push_failures(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;

    let reported = latest_agent(&state, id)
        .await
        .and_then(|agent| agent.get("failedPushes").and_then(Value::as_u64));

    let ack = reported.unwrap_or(0).min(i64::MAX as u64) as i64;
    sqlx::query("UPDATE monitors SET push_failures_ack = ? WHERE id = ?")
        .bind(ack)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;

    state.events.invalidate();

    Ok(Json(json!({
        "ok": true,
        "id": id,
        "pushFailuresAck": ack,
        "reported": reported,
    })))
}

/// POST /api/v1/monitors/{id}/agent-warnings/clear
///
/// Acknowledge every agent warning counter at once: `failedPushes`,
/// `samplesDropped` and the per-collector `collectorErrors`. The board shows
/// each reported counter minus its ack, so this clears the whole
/// "Agent: …" line on the card. Docker collector errors are acknowledged too
/// (the snapshot is complete), though the card renders them in the container
/// section instead. The counters reset when the agent restarts and ingest
/// drops stale acks, so a fresh failure is never masked.
pub async fn clear_agent_warnings(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;

    let reported = latest_agent(&state, id).await.unwrap_or_else(|| json!({}));
    let failed_pushes = reported
        .get("failedPushes")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(i64::MAX as u64) as i64;
    let samples_dropped = reported
        .get("samplesDropped")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(i64::MAX as u64) as i64;
    let collector_errors = reported
        .get("collectorErrors")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let collector_errors_json =
        serde_json::to_string(&collector_errors).unwrap_or_else(|_| "{}".to_string());

    sqlx::query(
        "UPDATE monitors SET push_failures_ack = ?, samples_dropped_ack = ?,
             collector_errors_ack = ? WHERE id = ?",
    )
    .bind(failed_pushes)
    .bind(samples_dropped)
    .bind(&collector_errors_json)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(internal)?;

    state.events.invalidate();

    Ok(Json(json!({
        "ok": true,
        "id": id,
        "pushFailuresAck": failed_pushes,
        "samplesDroppedAck": samples_dropped,
        "collectorErrorsAck": collector_errors,
        "reported": reported,
    })))
}

/// DELETE /api/v1/monitors/{id}
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;
    let delete_children = params.get("deleteChildren").map(String::as_str) == Some("true");

    let mut deleted = vec![id];

    if delete_children {
        // Breadth-first over descendants; ids are small integers and the
        // group tree is shallow, so one query per level is fine.
        let mut frontier = vec![id];
        while !frontier.is_empty() {
            let placeholders = vec!["?"; frontier.len()].join(",");
            let sql = format!("SELECT id FROM monitors WHERE parent IN ({placeholders})");
            let mut query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql));
            for parent in &frontier {
                query = query.bind(parent);
            }
            frontier = query.fetch_all(&state.pool).await.map_err(internal)?;
            deleted.extend(frontier.iter());
        }
    }

    // History first, in bounded batches; the monitor rows' cascade then has
    // almost nothing left to remove under the write lock.
    for monitor_id in &deleted {
        crate::db::delete_monitor_history(&state.pool, *monitor_id)
            .await
            .map_err(internal)?;
    }

    let placeholders = vec!["?"; deleted.len()].join(",");
    let sql = format!("DELETE FROM monitors WHERE id IN ({placeholders})");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for monitor_id in &deleted {
        query = query.bind(monitor_id);
    }
    query.execute(&state.pool).await.map_err(internal)?;

    for monitor_id in &deleted {
        state.engine.stop(*monitor_id);
        state.metrics.forget(*monitor_id);
    }
    state.events.invalidate();

    Ok(Json(json!({
        "ok": true,
        "deleted": deleted,
        "count": deleted.len(),
    })))
}

/// `notificationIDList` links, Node style: a map of notification id to
/// enabled (`{"1": true}`), or an array of ids meaning "exactly these".
async fn apply_notification_links(
    pool: &SqlitePool,
    monitor_id: i64,
    value: &Value,
) -> Result<(), ApiError> {
    match value {
        Value::Null => {}
        Value::Object(map) => {
            for (key, enabled) in map {
                let Ok(id) = key.parse::<i64>() else {
                    continue;
                };
                if enabled.as_bool().unwrap_or(false) {
                    sqlx::query(
                        "INSERT OR IGNORE INTO monitor_notifications (monitor_id, notification_id)
                         SELECT ?, id FROM notifications WHERE id = ?",
                    )
                    .bind(monitor_id)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(internal)?;
                } else {
                    sqlx::query(
                        "DELETE FROM monitor_notifications
                         WHERE monitor_id = ? AND notification_id = ?",
                    )
                    .bind(monitor_id)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(internal)?;
                }
            }
        }
        Value::Array(items) => {
            sqlx::query("DELETE FROM monitor_notifications WHERE monitor_id = ?")
                .bind(monitor_id)
                .execute(pool)
                .await
                .map_err(internal)?;
            for item in items {
                if let Some(id) = item.as_i64() {
                    sqlx::query(
                        "INSERT OR IGNORE INTO monitor_notifications (monitor_id, notification_id)
                         SELECT ?, id FROM notifications WHERE id = ?",
                    )
                    .bind(monitor_id)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(internal)?;
                }
            }
        }
        _ => {
            return Err(ApiError::bad(
                "`notificationIDList` must be an object or an array.",
            ));
        }
    }
    Ok(())
}

fn internal(e: sqlx::Error) -> ApiError {
    tracing::error!("monitors api: {e}");
    ApiError::server()
}
