//! Request budgets: per-group timeouts and concurrency limits (A3, A12).
//!
//! Plain `axum::middleware::from_fn` layers rather than tower's, so no extra
//! crate is needed. Both measure the time until the handler *returns its
//! response*: a streaming body (SSE, an agent binary) is not covered once
//! the headers are out, and it does not hold a concurrency slot.
//!
//! Layers are applied per route group in `api::router`, never to the whole
//! app, so a long-running group simply gets no timeout layer or its own
//! budget via [`with_timeout`]. Exempt today: the SSE stream and agent
//! binary downloads. A future upload group (large chunked PUTs, a
//! multi-GiB finalize) must be merged with its own budget, not the default.

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tokio::sync::Semaphore;

/// Default budget for an API request to produce its response.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Public read routes (status pages, badges) answer from cache or a few
/// indexed queries; anything slower is a stuck pool.
pub const PUBLIC_TIMEOUT: Duration = Duration::from_secs(15);

/// In-flight public read requests across the instance. Per-IP limiting is
/// not meaningful here: behind the Cloudflare Tunnel every request arrives
/// from the tunnel's address, and forwarded-for headers are spoofable when
/// the port is reached directly. A global cap protects the pool either way.
pub static PUBLIC_SLOTS: Semaphore = Semaphore::const_new(16);
/// How long a public request may wait for a slot before a 429.
pub const PUBLIC_WAIT: Duration = Duration::from_secs(2);

/// In-flight requests across every route that is not exempt.
pub static GLOBAL_SLOTS: Semaphore = Semaphore::const_new(256);
/// How long any request may wait for a global slot before a 503.
pub const GLOBAL_WAIT: Duration = Duration::from_secs(5);

/// Wrap a route group in a response timeout.
pub fn with_timeout<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    budget: Duration,
) -> Router<S> {
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        timeout(budget, request, next)
    }))
}

/// Wrap a route group in a concurrency limit.
pub fn with_concurrency_limit<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    slots: &'static Semaphore,
    wait: Duration,
    busy: fn() -> Response,
) -> Router<S> {
    router.layer(middleware::from_fn(move |request: Request, next: Next| {
        limit(slots, wait, busy, request, next)
    }))
}

async fn timeout(budget: Duration, request: Request, next: Next) -> Response {
    match tokio::time::timeout(budget, next.run(request)).await {
        Ok(response) => response,
        Err(_) => {
            tracing::warn!("request exceeded its {}s budget", budget.as_secs());
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, "5")],
                Json(json!({
                    "ok": false,
                    "error": "timeout",
                    "message": "The request took too long; retry shortly.",
                })),
            )
                .into_response()
        }
    }
}

async fn limit(
    slots: &'static Semaphore,
    wait: Duration,
    busy: fn() -> Response,
    request: Request,
    next: Next,
) -> Response {
    let Ok(Ok(_permit)) = tokio::time::timeout(wait, slots.acquire()).await else {
        return busy();
    };
    next.run(request).await
}

/// 429 for a saturated public surface.
pub fn public_busy() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, "5")],
        Json(json!({
            "ok": false,
            "error": "rate_limited",
            "message": "Too many requests; retry shortly.",
        })),
    )
        .into_response()
}

/// 503 for an instance at its in-flight cap.
pub fn global_busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "5")],
        Json(json!({
            "ok": false,
            "error": "busy",
            "message": "The server is busy; retry shortly.",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;

    async fn status(app: &Router, uri: &str) -> StatusCode {
        app.clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn slow_handlers_time_out_and_exempt_groups_do_not() {
        let slow = || async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "done"
        };
        let limited = with_timeout(
            Router::new().route("/slow", get(slow)),
            Duration::from_millis(20),
        );
        let exempt = Router::new().route("/exempt", get(slow));
        let app = limited.merge(exempt);

        assert_eq!(status(&app, "/slow").await, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(status(&app, "/exempt").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_saturated_group_answers_busy_and_recovers() {
        static ONE: Semaphore = Semaphore::const_new(1);
        let app = with_concurrency_limit(
            Router::new().route(
                "/work",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    "ok"
                }),
            ),
            &ONE,
            Duration::from_millis(10),
            public_busy,
        );

        let first = tokio::spawn({
            let app = app.clone();
            async move { status(&app, "/work").await }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(status(&app, "/work").await, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(first.await.unwrap(), StatusCode::OK);
        assert_eq!(status(&app, "/work").await, StatusCode::OK);
    }
}
