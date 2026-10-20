//! Token checks over HTTP: a token-store failure is 503, never 401 (A1).

use axum::http::StatusCode;
use serde_json::json;

mod common;
use common::{harness, request, send};

#[tokio::test]
async fn a_failing_token_store_answers_503_not_401() {
    let h = harness().await;

    // Sanity: the token works while the database does.
    let (status, _) = send(
        &h.app,
        request("GET", "/api/v1/auth/me", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    h.pool.close().await;

    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "unavailable");

    // The SSE endpoint goes through the same middleware.
    let (status, _) = send(
        &h.app,
        request("GET", "/api/v1/events", Some(&h.token), None),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // Sign-in must not tell the operator their token is wrong either.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "username": "", "password": h.token })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "unavailable");

    // Provisioning shares the rule.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/agent/version?token={}", h.token),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // A missing token is still a plain 401: nothing to check.
    let (status, _) = send(&h.app, request("GET", "/api/v1/monitors", None, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_tokens_are_still_401() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some("flatline_nope"), None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}

#[tokio::test]
async fn minted_tokens_carry_their_family_prefix() {
    let h = harness().await;
    assert!(
        h.token.starts_with("flatline_op_"),
        "the admin token must be an operator token, got {}",
        h.token
    );

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "prefix-edge", "type": "push" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(
        body["monitor"]["pushToken"]
            .as_str()
            .unwrap()
            .starts_with("flatline_agent_push_")
    );
    assert_eq!(body["monitor"]["pushTokenKind"], "push_agent");
}

#[tokio::test]
async fn agent_tokens_are_rejected_on_operator_surfaces() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "agent-token-edge", "type": "push" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let push = body["monitor"]["pushToken"].as_str().unwrap().to_string();

    // GUI sign-in must say "agent token", not "invalid".
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "password": push })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");
    assert_eq!(body["tokenKind"], "push_agent");
    assert_eq!(body["expectedTokenKind"], "operator");
    assert!(
        body["hint"].as_str().unwrap().contains("flatline_op_"),
        "the hint must name the operator prefix: {body}"
    );

    // The operator API answers the same way.
    let (status, body) = send(
        &h.app,
        request("GET", "/api/v1/monitors", Some(&push), None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");

    // A backup token is also an agent token, even without a stored row: the
    // prefix alone is enough to route the error.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "password": "flatline_agent_backup_deadbeef" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");
    assert_eq!(body["tokenKind"], "backup_agent");
}

#[tokio::test]
async fn operator_tokens_are_rejected_on_agent_surfaces() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request("GET", &format!("/api/push/{}", h.token), None, None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "operator_token_on_agent_api");
    assert_eq!(body["tokenKind"], "operator");

    // Provisioning downloads accept operator tokens, so that stays 200.
    let (status, _) = send(
        &h.app,
        request(
            "GET",
            &format!("/agent/version?token={}", h.token),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn legacy_push_tokens_are_still_recognised_as_agent_tokens() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "legacy-edge", "type": "push" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["monitor"]["id"].as_i64().unwrap();

    // Simulate a monitor provisioned before the prefix split.
    let legacy = "flatline_0123456789abcdef0123456789abcdef01234567";
    sqlx::query("UPDATE monitors SET push_token = ? WHERE id = ?")
        .bind(legacy)
        .bind(id)
        .execute(&h.pool)
        .await
        .unwrap();

    // The legacy token still pushes.
    let (status, _) = send(
        &h.app,
        request("GET", &format!("/api/push/{legacy}"), None, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // And using it to sign in names the agent token, not a generic 401.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "password": legacy })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");
    assert_eq!(body["tokenKind"], "push_agent");
}

#[tokio::test]
async fn agent_families_do_not_cross_endpoints() {
    let h = harness().await;

    // A backup token in a push URL is named as such.
    let (status, body) = send(
        &h.app,
        request(
            "GET",
            "/api/push/flatline_agent_backup_deadbeef",
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "backup_agent_token_on_metric_agent_api");

    // A push token on the backup API is named as such.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/backup/v1/runs",
            Some("flatline_agent_push_deadbeef"),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "push_agent_token_on_backup_agent_api");

    // An operator token on the backup API points at the agent credential.
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/backup/v1/runs",
            Some(&h.token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "operator_token_on_agent_api");

    // A backup token cannot fetch metric-agent downloads.
    let (status, body) = send(
        &h.app,
        request(
            "GET",
            "/agent/version?token=flatline_agent_backup_deadbeef",
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "backup_agent_token_on_metric_agent_api");
}

#[tokio::test]
async fn bare_pre_2026_push_tokens_are_recognised_as_agent_tokens() {
    let h = harness().await;
    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/monitors",
            Some(&h.token),
            Some(json!({ "name": "bare-edge", "type": "push" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = body["monitor"]["id"].as_i64().unwrap();

    // Node-era agents carry a bare 32-hex token with no prefix at all.
    let bare = "94df87289c677ce82b1d4850d8e1a1b2";
    sqlx::query("UPDATE monitors SET push_token = ? WHERE id = ?")
        .bind(bare)
        .bind(id)
        .execute(&h.pool)
        .await
        .unwrap();

    let (status, _) = send(
        &h.app,
        request("GET", &format!("/api/push/{bare}"), None, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &h.app,
        request(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "password": bare })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "agent_token_on_operator_api");
    assert_eq!(body["tokenKind"], "push_agent");
}
