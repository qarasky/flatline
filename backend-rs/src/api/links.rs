//! Server -> website link handlers.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;
use crate::api::monitors::load;
use crate::links;

/// GET /api/v1/monitors/links?ids=1,2,3
///
/// The Superboard fetches links for every card in one request. Servers
/// without links are absent from `servers`.
pub async fn bulk(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let raw = params.get("ids").cloned().unwrap_or_default();
    let parts: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();

    if parts.is_empty() || parts.len() > links::MAX_LINKS {
        return Err(ApiError::bad(
            "`ids` must be a comma-separated list of 1 to 200 monitor ids.",
        ));
    }

    let mut ids = Vec::with_capacity(parts.len());
    for part in parts {
        let id: i64 = part.parse().ok().filter(|n| *n > 0).ok_or_else(|| {
            ApiError::bad("`ids` must be a comma-separated list of positive integers.")
        })?;
        ids.push(id);
    }

    let (count, servers) = links::for_many(&state.pool, &ids).await?;
    Ok(Json(
        json!({ "ok": true, "count": count, "servers": servers }),
    ))
}

/// GET /api/v1/monitors/{id}/links
pub async fn single(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;
    let (raw, resolved) = links::resolve(&state.pool, id).await?;
    Ok(Json(
        json!({ "ok": true, "monitorId": id, "raw": raw, "resolved": resolved }),
    ))
}

/// PUT /api/v1/monitors/{id}/links
///
/// Body `{ linkedMonitorIds: number[] }` replaces the server's links exactly.
pub async fn replace(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;

    let payload = body
        .as_object()
        .ok_or_else(|| ApiError::bad("body must be a JSON object"))?;
    let items = payload
        .get("linkedMonitorIds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::bad("`linkedMonitorIds` must be an array of positive integers.")
        })?;
    if items.len() > links::MAX_LINKS {
        return Err(ApiError::bad(
            "`linkedMonitorIds` must be an array of up to 200 positive integers.",
        ));
    }

    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = item.as_i64().filter(|n| *n > 0).ok_or_else(|| {
            ApiError::bad("`linkedMonitorIds` must be an array of positive integers.")
        })?;
        ids.push(id);
    }

    links::replace(&state.pool, id, &ids).await?;
    state.events.invalidate();

    let (raw, resolved) = links::resolve(&state.pool, id).await?;
    Ok(Json(
        json!({ "ok": true, "monitorId": id, "raw": raw, "resolved": resolved }),
    ))
}

/// DELETE /api/v1/monitors/{id}/links
pub async fn clear(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let _monitor = load(&state.pool, id).await?;
    links::clear(&state.pool, id).await?;
    state.events.invalidate();
    Ok(Json(
        json!({ "ok": true, "monitorId": id, "raw": [], "resolved": [] }),
    ))
}
