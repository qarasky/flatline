//! Kore ID sign-in against an in-process OpenID provider: the
//! authorization-code + PKCE flow, id-token and bearer verification,
//! allowlisted provisioning, and the local-login switches.

use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod common;
use common::{Harness, harness, harness_with_sso, request, send, send_full, with_cookie};
use flatline_backend::config::KoreIdConfig;

const CLIENT_ID: &str = "flatline";
const SECRET: &str = "s3cret";
const SUB: &str = "6f1c3c1e-0000-4000-8000-00000000a001";

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// What the mock provider will answer to the token request.
#[derive(Default, Clone)]
struct Next {
    sub: String,
    email: String,
    name: String,
    /// Replace the nonce, audience or signing key to make a bad token.
    nonce: Option<String>,
    aud: Option<String>,
    wrong_key: bool,
    code_challenge: String,
}

#[derive(Clone)]
struct Mock {
    key: SigningKey,
    other: SigningKey,
    issuer: String,
    next: Arc<Mutex<Next>>,
    /// The last token request's `Authorization` header and body.
    last: Arc<Mutex<(Option<String>, String)>>,
}

impl Mock {
    fn sign(&self, claims: Value, wrong_key: bool) -> String {
        let key = if wrong_key { &self.other } else { &self.key };
        let head = b64(json!({"alg": "EdDSA", "typ": "JWT", "kid": "k1"}).to_string().as_bytes());
        let body = b64(claims.to_string().as_bytes());
        let signed = format!("{head}.{body}");
        let signature = key.sign(signed.as_bytes());
        format!("{signed}.{}", b64(&signature.to_bytes()))
    }

    /// An access token as Kore ID mints it (has `scope`).
    fn access_token(&self, sub: &str, aud: &str, exp_in: i64) -> String {
        self.sign(
            json!({"iss": self.issuer, "aud": aud, "sub": sub, "scope": "openid profile email",
                   "exp": chrono::Utc::now().timestamp() + exp_in}),
            false,
        )
    }
}

async fn discovery(State(m): State<Mock>) -> Json<Value> {
    Json(json!({
        "issuer": m.issuer,
        "authorization_endpoint": format!("{}/authorize", m.issuer),
        "token_endpoint": format!("{}/token", m.issuer),
        "jwks_uri": format!("{}/.well-known/jwks.json", m.issuer),
        "end_session_endpoint": format!("{}/logout", m.issuer),
    }))
}

async fn jwks(State(m): State<Mock>) -> Json<Value> {
    Json(json!({"keys": [{
        "kty": "OKP", "crv": "Ed25519", "kid": "k1", "alg": "EdDSA", "use": "sig",
        "x": b64(m.key.verifying_key().as_bytes()),
    }]}))
}

async fn token(
    State(m): State<Mock>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, Json<Value>) {
    *m.last.lock().unwrap() = (
        headers.get("authorization").map(|v| v.to_str().unwrap().to_string()),
        body.clone(),
    );
    let form: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
    let next = m.next.lock().unwrap().clone();
    let verifier_ok = form
        .get("code_verifier")
        .is_some_and(|v| b64(&Sha256::digest(v.as_bytes())) == next.code_challenge);
    if form.get("code").map(String::as_str) != Some("good-code") || !verifier_ok {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"})));
    }
    let now = chrono::Utc::now().timestamp();
    let id_token = m.sign(
        json!({
            "iss": m.issuer, "aud": next.aud.clone().unwrap_or_else(|| CLIENT_ID.into()),
            "sub": next.sub, "email": next.email, "name": next.name,
            "nonce": next.nonce, "iat": now, "exp": now + 600,
        }),
        next.wrong_key,
    );
    (
        StatusCode::OK,
        Json(json!({"token_type": "Bearer", "id_token": id_token,
                    "access_token": m.access_token(&next.sub, CLIENT_ID, 600)})),
    )
}

async fn provider() -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let mock = Mock {
        key: SigningKey::from_bytes(&[7u8; 32]),
        other: SigningKey::from_bytes(&[9u8; 32]),
        issuer,
        next: Arc::default(),
        last: Arc::default(),
    };
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/.well-known/jwks.json", get(jwks))
        .route("/token", post(token))
        .with_state(mock.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    mock
}

fn kore(mock: &Mock, emails: &[&str], subs: &[&str]) -> KoreIdConfig {
    KoreIdConfig {
        issuer: mock.issuer.clone(),
        client_id: CLIENT_ID.into(),
        client_secret: Some(SECRET.into()),
        client_auth_post: false,
        redirect_uri: "https://uptime.example/api/v1/auth/sso/callback".into(),
        post_logout_redirect_uri: "https://uptime.example/sign-in".into(),
        allowed_emails: emails.iter().map(|e| e.to_string()).collect(),
        allowed_subs: subs.iter().map(|s| s.to_string()).collect(),
    }
}

fn header(response: &axum::http::Response<axum::body::Body>, name: &str) -> Vec<String> {
    response
        .headers()
        .get_all(name)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect()
}

async fn get_raw(app: &Router, uri: &str, cookie: Option<&str>) -> axum::http::Response<axum::body::Body> {
    use tower::ServiceExt;
    let mut builder = axum::http::Request::builder().method("GET").uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    app.clone().oneshot(builder.body(axum::body::Body::empty()).unwrap()).await.unwrap()
}

/// What `/sso/start` told the browser.
struct Started {
    state: String,
    nonce: String,
    challenge: String,
    binding_cookie: String,
}

async fn start(h: &Harness, next: &str) -> Started {
    let response = get_raw(&h.app, &format!("/api/v1/auth/sso/start?next={next}"), None).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = header(&response, "location").remove(0);
    let url = reqwest::Url::parse(&location).unwrap();
    assert!(location.contains("/authorize?"), "{location}");
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], CLIENT_ID);
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["scope"], "openid profile email");
    assert_eq!(q["redirect_uri"], "https://uptime.example/api/v1/auth/sso/callback");
    let cookie = header(&response, "set-cookie").remove(0);
    assert!(cookie.starts_with("fl_sso=") && cookie.contains("HttpOnly"), "{cookie}");
    Started {
        state: q["state"].clone(),
        nonce: q["nonce"].clone(),
        challenge: q["code_challenge"].clone(),
        binding_cookie: cookie.split(';').next().unwrap().to_string(),
    }
}

fn identity(mock: &Mock, s: &Started, email: &str) {
    *mock.next.lock().unwrap() = Next {
        sub: SUB.into(),
        email: email.into(),
        name: "Ana Kore".into(),
        nonce: Some(s.nonce.clone()),
        code_challenge: s.challenge.clone(),
        ..Next::default()
    };
}

/// Drive the callback; returns (location, session cookie if any).
async fn callback(h: &Harness, s: &Started, code: &str, cookie: Option<&str>) -> (String, Option<String>) {
    let uri = format!("/api/v1/auth/sso/callback?code={code}&state={}", s.state);
    let response = get_raw(&h.app, &uri, cookie).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = header(&response, "location").remove(0);
    let session = header(&response, "set-cookie")
        .into_iter()
        .find(|c| c.starts_with("fl_session=") && !c.starts_with("fl_session=;"))
        .map(|c| c.split(';').next().unwrap().trim_start_matches("fl_session=").to_string());
    (location, session)
}

async fn sign_in_via_sso(h: &Harness, mock: &Mock, email: &str) -> String {
    let s = start(h, "/monitors").await;
    identity(mock, &s, email);
    let (location, session) = callback(h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/monitors");
    session.expect("a session cookie")
}

#[tokio::test]
async fn allowlisted_email_signs_in_and_is_provisioned_once() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;

    let session = sign_in_via_sso(&h, &mock, "Ana@Office.kz").await;
    let (status, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["principal"], "account");
    assert_eq!(body["account"]["email"], "Ana@Office.kz");
    assert_eq!(body["account"]["name"], "Ana Kore");
    assert_eq!(body["account"]["mustChangePassword"], false);
    let id = body["account"]["id"].as_i64().unwrap();

    // The same subject again is the same account.
    let again = sign_in_via_sso(&h, &mock, "Ana@Office.kz").await;
    let (_, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &again, None)).await;
    assert_eq!(body["account"]["id"].as_i64().unwrap(), id);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&h.pool).await.unwrap();
    assert_eq!(count, 1);

    // The token request authenticated as a confidential client (Basic) with PKCE.
    let (auth, body) = mock.last.lock().unwrap().clone();
    assert_eq!(auth.unwrap(), format!("Basic {}", STANDARD.encode(format!("{CLIENT_ID}:{SECRET}"))));
    assert!(body.contains("code_verifier=") && !body.contains("client_secret"));

    // An SSO account has no password: nothing signs in with the sentinel.
    for password in ["!sso", "", "anything at all"] {
        let (status, _) = send(
            &h.app,
            request("POST", "/api/v1/auth/session", None, Some(json!({"email": "ana@office.kz", "password": password}))),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn an_unlisted_identity_gets_no_account_and_no_session() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["someone.else@office.kz"], &[])).await;
    let s = start(&h, "/").await;
    identity(&mock, &s, "ana@office.kz");
    let (location, session) = callback(&h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/sign-in?sso_error=denied");
    assert!(session.is_none());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&h.pool).await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn subject_allowlist_and_linking_an_existing_local_account() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &[], &[SUB])).await;
    let local = common::add_member(&h, "ana@office.kz", "Ana", "correct horse").await;
    let session = sign_in_via_sso(&h, &mock, "ana@office.kz").await;
    let (_, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(body["account"]["id"].as_i64().unwrap(), local, "linked, not duplicated");
    let sub: String = sqlx::query_scalar("SELECT kore_sub FROM users WHERE id = ?")
        .bind(local).fetch_one(&h.pool).await.unwrap();
    assert_eq!(sub, SUB);
}

#[tokio::test]
async fn the_callback_is_bound_to_the_browser_and_single_use() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;

    // No binding cookie: a callback replayed in another browser.
    let s = start(&h, "/").await;
    identity(&mock, &s, "ana@office.kz");
    let (location, session) = callback(&h, &s, "good-code", None).await;
    assert_eq!(location, "/sign-in?sso_error=state");
    assert!(session.is_none());

    // The state was consumed by that attempt, even though it failed.
    let (location, _) = callback(&h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/sign-in?sso_error=state");

    // Unknown state and a wrong cookie value.
    let s = start(&h, "/").await;
    identity(&mock, &s, "ana@office.kz");
    let (location, _) = callback(&h, &s, "good-code", Some("fl_sso=forged")).await;
    assert_eq!(location, "/sign-in?sso_error=state");
    let response = get_raw(&h.app, "/api/v1/auth/sso/callback?code=good-code&state=nope", None).await;
    assert_eq!(header(&response, "location")[0], "/sign-in?sso_error=state");

    // A provider error and a foreign issuer are refused.
    let response = get_raw(&h.app, "/api/v1/auth/sso/callback?error=access_denied", None).await;
    assert_eq!(header(&response, "location")[0], "/sign-in?sso_error=provider");
    let s = start(&h, "/").await;
    let uri = format!("/api/v1/auth/sso/callback?code=good-code&state={}&iss=https://evil.example", s.state);
    let response = get_raw(&h.app, &uri, Some(&s.binding_cookie)).await;
    assert_eq!(header(&response, "location")[0], "/sign-in?sso_error=state");
}

#[tokio::test]
async fn bad_id_tokens_are_refused() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;
    for tamper in ["nonce", "aud", "key", "code"] {
        let s = start(&h, "/").await;
        identity(&mock, &s, "ana@office.kz");
        let mut code = "good-code";
        {
            let mut next = mock.next.lock().unwrap();
            match tamper {
                "nonce" => next.nonce = Some("not-the-nonce".into()),
                "aud" => next.aud = Some("koremind".into()),
                "key" => next.wrong_key = true,
                _ => code = "bad-code",
            }
        }
        let (location, session) = callback(&h, &s, code, Some(&s.binding_cookie)).await;
        let expected = if tamper == "code" { "provider" } else { "token" };
        assert_eq!(location, format!("/sign-in?sso_error={expected}"), "{tamper}");
        assert!(session.is_none(), "{tamper}");
    }
}

#[tokio::test]
async fn next_cannot_leave_the_site() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;
    let s = start(&h, "//evil.example/x").await;
    identity(&mock, &s, "ana@office.kz");
    let (location, session) = callback(&h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/");
    assert!(session.is_some());
}

#[tokio::test]
async fn kore_access_tokens_work_as_bearers_for_signed_in_accounts_only() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;

    // Valid token, but the person never signed in here: refused.
    let token = mock.access_token(SUB, CLIENT_ID, 600);
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&token), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    sign_in_via_sso(&h, &mock, "ana@office.kz").await;
    let (status, body) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&token), None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["account"]["email"], "ana@office.kz");

    // Wrong audience (a KoreMind token), expired, other subject, no scope
    // (an id token), wrong key, and a mangled token.
    let id_like = mock.sign(json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB,
        "exp": chrono::Utc::now().timestamp() + 600}), false);
    let forged = mock.sign(json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB, "scope": "openid",
        "exp": chrono::Utc::now().timestamp() + 600}), true);
    for bad in [
        mock.access_token(SUB, "koremind", 600),
        mock.access_token(SUB, CLIENT_ID, -3600),
        mock.access_token("someone-else", CLIENT_ID, 600),
        id_like,
        forged,
        format!("{}x", token),
        "eyJhbGciOiJub25lIn0.e30.".to_string(),
    ] {
        let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&bad), None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{bad}");
    }

    // Machine credentials are untouched by all of this.
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&h.token), None)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn jwt_bearers_are_refused_when_sso_is_off() {
    let mock = provider().await;
    let h = harness().await;
    let token = mock.access_token(SUB, CLIENT_ID, 600);
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&token), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = send(&h.app, request("GET", "/api/v1/auth/sso/config", None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sso"], false);
    let response = get_raw(&h.app, "/api/v1/auth/sso/start", None).await;
    assert_eq!(header(&response, "location")[0], "/sign-in?sso_error=disabled");
}

#[tokio::test]
async fn signing_out_returns_the_provider_logout_url() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;
    let session = sign_in_via_sso(&h, &mock, "ana@office.kz").await;

    let (status, _, body) = send_full(&h.app, with_cookie("DELETE", "/api/v1/auth/session", &session, None)).await;
    assert_eq!(status, StatusCode::OK);
    let url = reqwest::Url::parse(body["ssoLogoutUrl"].as_str().expect("a logout url")).unwrap();
    assert_eq!(url.path(), "/logout");
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["post_logout_redirect_uri"], "https://uptime.example/sign-in");
    assert_eq!(q["id_token_hint"].split('.').count(), 3);

    // The local session is gone.
    let (status, _) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A password session has no provider session to end.
    common::add_member(&h, "bo@office.kz", "Bo", "correct horse").await;
    let local = common::sign_in(&h.app, json!({"email": "bo@office.kz", "password": "correct horse"})).await;
    let (_, _, body) = send_full(&h.app, with_cookie("DELETE", "/api/v1/auth/session", &local, None)).await;
    assert!(body.get("ssoLogoutUrl").is_none());
}

#[tokio::test]
async fn local_login_can_be_switched_off_without_touching_bearer_tokens() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;
    common::add_member(&h, "bo@office.kz", "Bo", "correct horse").await;

    let mut state = h.state.clone();
    let mut config = (*state.config).clone();
    config.local_login = false;
    config.token_login = false;
    state.config = Arc::new(config);
    let app = flatline_backend::api::router(state);

    for body in [
        json!({"email": "bo@office.kz", "password": "correct horse"}),
        json!({"token": h.token}),
    ] {
        let (status, cookie, answer) = send_full(&app, request("POST", "/api/v1/auth/session", None, Some(body))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
        assert!(cookie.is_none());
    }
    let (status, _) = send(&app, request("POST", "/api/v1/auth/login", None, Some(json!({"password": h.token})))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(&app, request("POST", "/api/v1/auth/setup", None, Some(json!({})))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (_, body) = send(&app, request("GET", "/api/v1/auth/sso/config", None, None)).await;
    assert_eq!((body["sso"].clone(), body["localLogin"].clone(), body["tokenLogin"].clone()), (json!(true), json!(false), json!(false)));

    // The operator token as a bearer, for scripts and AI agents, still works.
    let (status, _) = send(&app, request("GET", "/api/v1/monitors", Some(&h.token), None)).await;
    assert_eq!(status, StatusCode::OK);
}
