//! Notification configs (Telegram only in v1).
//!
//! The importer seeds these from the old database; this API lets the
//! operator inspect and edit them without SQL. Bot tokens are never echoed
//! back out, matching the Node listing.

use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::ApiError;

type NotificationRow = (i64, String, String, i64, i64, String);

/// GET /api/v1/notifications
pub async fn list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows: Vec<NotificationRow> = sqlx::query_as(
        "SELECT id, name, type, active, is_default, config FROM notifications ORDER BY id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(internal)?;

    let notifications: Vec<Value> = rows
        .iter()
        .map(|(id, name, kind, active, is_default, config)| {
            let mut parsed: Value = serde_json::from_str(config).unwrap_or_else(|_| json!({}));
            // Never echo credentials back out.
            if let Some(object) = parsed.as_object_mut() {
                object.remove("telegramBotToken");
            }
            json!({
                "id": id,
                "name": name,
                "type": kind,
                "active": *active != 0,
                "isDefault": *is_default != 0,
                "config": parsed,
            })
        })
        .collect();

    Ok(Json(json!({
        "ok": true,
        "count": notifications.len(),
        "notifications": notifications,
    })))
}

/// POST /api/v1/notifications
pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let payload = body
        .as_object()
        .ok_or_else(|| ApiError::bad("body must be a JSON object"))?;

    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("telegram")
        .to_string();
    let active = payload
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let is_default = payload
        .get("isDefault")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let config = payload.get("config").cloned().unwrap_or_else(|| json!({}));
    if !config.is_object() {
        return Err(ApiError::bad("`config` must be a JSON object."));
    }

    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO notifications (name, type, active, is_default, config)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&name)
    .bind(&kind)
    .bind(if active { 1 } else { 0 })
    .bind(if is_default { 1 } else { 0 })
    .bind(config.to_string())
    .fetch_one(&state.pool)
    .await
    .map_err(internal)?;

    state.events.invalidate();

    Ok(Json(json!({ "ok": true, "id": id })))
}

/// PATCH /api/v1/notifications/{id}
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let payload = body
        .as_object()
        .ok_or_else(|| ApiError::bad("body must be a JSON object"))?;

    let existing: Option<NotificationRow> = sqlx::query_as(
        "SELECT id, name, type, active, is_default, config FROM notifications WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?;

    let Some((_, name, kind, active, is_default, config)) = existing else {
        return Err(ApiError::not_found(format!(
            "No notification with id {id}."
        )));
    };

    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&name)
        .to_string();
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(&kind)
        .to_string();
    let active = payload
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(active != 0);
    let is_default = payload
        .get("isDefault")
        .and_then(Value::as_bool)
        .unwrap_or(is_default != 0);
    let config = match payload.get("config") {
        Some(value) if value.is_object() => value.to_string(),
        Some(_) => return Err(ApiError::bad("`config` must be a JSON object.")),
        None => config,
    };

    sqlx::query(
        "UPDATE notifications SET name = ?, type = ?, active = ?, is_default = ?, config = ?
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&kind)
    .bind(if active { 1 } else { 0 })
    .bind(if is_default { 1 } else { 0 })
    .bind(&config)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(internal)?;

    state.events.invalidate();

    Ok(Json(json!({ "ok": true, "id": id })))
}

/// DELETE /api/v1/notifications/{id}
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let result = sqlx::query("DELETE FROM notifications WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal)?;

    if result.rows_affected() == 0 {
        return Err(ApiError::not_found(format!(
            "No notification with id {id}."
        )));
    }

    state.events.invalidate();

    Ok(Json(json!({ "ok": true, "deleted": id })))
}

fn internal(error: sqlx::Error) -> ApiError {
    tracing::error!("notifications api: {error}");
    ApiError::server()
}
