//! The OpenAPI description, served unauthenticated like the Node route: it
//! contains no secrets, and an agent should be able to read it before
//! minting a token.

use axum::http::header;
use axum::response::{IntoResponse, Response};

/// The document lives in openapi.json so it can be linted and diffed.
const DOCUMENT: &str = include_str!("openapi.json");

/// GET /api/v1/openapi.json
pub async fn document() -> Response {
    ([(header::CONTENT_TYPE, "application/json")], DOCUMENT).into_response()
}
