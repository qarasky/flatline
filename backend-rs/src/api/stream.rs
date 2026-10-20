//! SSE live stream: `GET /api/v1/events`.
//!
//! Parity with the Node backend: `ready` on connect, keepalive every 15s,
//! token revalidation every 15s (`unauthorized` + close when revoked),
//! 15-minute lifetime (clients reconnect), per-token and instance-wide
//! stream caps, and a slow client is closed rather than queued.

use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::AppState;
use crate::api::ApiError;
use crate::auth;

const KEEPALIVE_SECS: u64 = 15;
const LIFETIME_SECS: u64 = 15 * 60;

/// GET /api/v1/events
pub async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    // The middleware already verified the token; re-read it for the stream
    // key and for periodic revalidation.
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();

    let key = auth::hash_token(&token);
    let guard = state
        .events
        .try_open(&key)
        .ok_or_else(ApiError::stream_limit)?;
    let metrics_enabled = params.get("metrics").map(String::as_str) != Some("0");

    let mut receiver = state.events.subscribe();
    let pool = state.pool.clone();
    let stream = async_stream::stream! {
        // Hold the slot for the stream's lifetime.
        let _guard = guard;

        yield Ok::<Event, Infallible>(Event::default().data(json!({"type": "ready"}).to_string()));

        let mut keepalive = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(KEEPALIVE_SECS),
            Duration::from_secs(KEEPALIVE_SECS),
        );
        let lifetime = tokio::time::sleep(Duration::from_secs(LIFETIME_SECS));
        tokio::pin!(lifetime);

        loop {
            tokio::select! {
                _ = &mut lifetime => break,
                _ = keepalive.tick() => {
                    if !auth::verify_token(&pool, &token).await {
                        yield Ok(Event::default().data(json!({"type": "unauthorized"}).to_string()));
                        break;
                    }
                    yield Ok(Event::default().comment("keepalive"));
                }
                received = receiver.recv() => match received {
                    Ok(event) => {
                        // Pre-serialized at publish time: no per-stream JSON work.
                        if !metrics_enabled && event.kind() == "metrics" {
                            continue;
                        }
                        yield Ok(Event::default().data(event.data()));
                    }
                    // A lagging receiver means a slow client: drop it rather
                    // than queue stale telemetry.
                    Err(RecvError::Lagged(_)) => break,
                    Err(RecvError::Closed) => break,
                },
            }
        }
    };

    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CACHE_CONTROL,
        "no-cache, no-transform".parse().unwrap(),
    );
    response_headers.insert("x-accel-buffering", "no".parse().unwrap());
    Ok(response)
}
