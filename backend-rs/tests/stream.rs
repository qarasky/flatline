//! SSE stream contract: auth, ready frame, invalidate delivery, stream caps.

use axum::http::StatusCode;
use tower::ServiceExt;

mod common;
use common::{harness, next_sse_data, request, send};

#[tokio::test]
async fn stream_requires_a_token() {
    let h = harness().await;
    let (status, _) = send(&h.app, request("GET", "/api/v1/events", None, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stream_sends_ready_then_invalidations() {
    let h = harness().await;

    let response = h
        .app
        .clone()
        .oneshot(request("GET", "/api/v1/events", Some(&h.token), None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("text/event-stream")
    );
    assert_eq!(response.headers().get("x-accel-buffering").unwrap(), "no");

    let mut body = response.into_body();

    let ready = next_sse_data(&mut body).await;
    assert_eq!(ready["type"], "ready");

    // A monitor mutation publishes invalidate; the stream must deliver it.
    h.state.events.invalidate();
    let event = next_sse_data(&mut body).await;
    assert_eq!(event["type"], "invalidate");
}

#[tokio::test]
async fn stream_caps_are_enforced() {
    let h = harness().await;

    // Hold eight open streams (the guard lives inside the response body).
    let mut held = Vec::new();
    for _ in 0..8 {
        let response = h
            .app
            .clone()
            .oneshot(request("GET", "/api/v1/events", Some(&h.token), None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        held.push(response);
    }

    // The ninth is refused with the Node envelope.
    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/events", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"], "stream_limit");

    // Dropping one stream frees a slot.
    held.pop();
    let response = h
        .app
        .clone()
        .oneshot(request("GET", "/api/v1/events", Some(&h.token), None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
