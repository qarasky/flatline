//! Kore ID sign-in against an in-process OpenID provider: the
//! authorization-code + PKCE flow, id-token and bearer verification,
//! provisioning (on by default, optional allowlists), email linking,
//! back-channel logout, and the local-login switches.

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
    /// Kore ID marks every email verified; set to send `email_verified: false`.
    unverified: bool,
    /// The Kore ID session id put in the tokens (`sid-1` when empty).
    sid: String,
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
        self.sign_typed("JWT", claims, wrong_key)
    }

    fn sign_typed(&self, typ: &str, claims: Value, wrong_key: bool) -> String {
        let key = if wrong_key { &self.other } else { &self.key };
        let head = b64(json!({"alg": "EdDSA", "typ": typ, "kid": "k1"}).to_string().as_bytes());
        let body = b64(claims.to_string().as_bytes());
        let signed = format!("{head}.{body}");
        let signature = key.sign(signed.as_bytes());
        format!("{signed}.{}", b64(&signature.to_bytes()))
    }

    /// An access token as Kore ID mints it (`typ: at+jwt`, RFC 9068).
    fn access_token(&self, sub: &str, aud: &str, exp_in: i64) -> String {
        self.access_token_in(sub, aud, exp_in, "sid-1")
    }

    fn access_token_in(&self, sub: &str, aud: &str, exp_in: i64, sid: &str) -> String {
        let now = chrono::Utc::now().timestamp();
        self.sign_typed(
            "at+jwt",
            json!({"iss": self.issuer, "aud": aud, "client_id": aud, "sub": sub, "sid": sid,
                   "scope": "openid profile email", "jti": format!("at-{now}-{sid}"),
                   "iat": now, "exp": now + exp_in}),
            false,
        )
    }

    /// The claims of a logout token as Kore ID sends it; tests tamper with them.
    fn logout_claims(&self, sid: Option<&str>, sub: Option<&str>) -> Value {
        let now = chrono::Utc::now().timestamp();
        let mut claims = json!({
            "iss": self.issuer, "aud": CLIENT_ID, "iat": now, "exp": now + 120,
            "jti": format!("jti-{}", rand_suffix()),
            "events": {"http://schemas.openid.net/event/backchannel-logout": {}},
        });
        if let Some(sid) = sid {
            claims["sid"] = json!(sid);
        }
        if let Some(sub) = sub {
            claims["sub"] = json!(sub);
        }
        claims
    }

    fn logout_token(&self, claims: Value) -> String {
        self.sign_typed("logout+jwt", claims, false)
    }
}

fn rand_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
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
    let sid = if next.sid.is_empty() { "sid-1".to_string() } else { next.sid.clone() };
    let id_token = m.sign(
        json!({
            "iss": m.issuer, "aud": next.aud.clone().unwrap_or_else(|| CLIENT_ID.into()),
            "azp": CLIENT_ID, "sub": next.sub, "email": next.email,
            "email_verified": !next.unverified, "name": next.name, "sid": sid,
            "nonce": next.nonce, "iat": now, "auth_time": now, "exp": now + 600,
        }),
        next.wrong_key,
    );
    (
        StatusCode::OK,
        Json(json!({"token_type": "Bearer", "id_token": id_token,
                    "access_token": m.access_token_in(&next.sub, CLIENT_ID, 600, &sid)})),
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

/// Kore ID with the optional allowlist filters (empty: anyone Kore ID admits).
fn kore(mock: &Mock, emails: &[&str], subs: &[&str]) -> KoreIdConfig {
    KoreIdConfig {
        issuer: mock.issuer.clone(),
        client_id: CLIENT_ID.into(),
        client_secret: Some(SECRET.into()),
        client_auth_post: false,
        redirect_uri: "https://uptime.example/api/v1/auth/sso/callback".into(),
        post_logout_redirect_uri: "https://uptime.example/sign-in".into(),
        auto_provision: true,
        account_url: format!("{}/account", mock.issuer),
        app_urls: vec![("kore".into(), "https://files.example".into())],
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
    sign_in_via_sso_with(h, mock, email, |_| {}).await
}

/// Sign in, adjusting what the provider returns first (another `sid`, say).
async fn sign_in_via_sso_with(h: &Harness, mock: &Mock, email: &str, tweak: impl FnOnce(&mut Next)) -> String {
    let s = start(h, "/monitors").await;
    identity(mock, &s, email);
    tweak(&mut mock.next.lock().unwrap());
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
    // `application/at+jwt` is the same media type.
    let long_typ = mock.sign_typed(
        "application/at+jwt",
        json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB, "scope": "openid",
               "exp": chrono::Utc::now().timestamp() + 600}),
        false,
    );
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&long_typ), None)).await;
    assert_eq!(status, StatusCode::OK);

    // Wrong audience (a KoreMind token), expired, other subject, an id
    // token (typ JWT, even one carrying a scope), a logout token, a foreign
    // client_id, wrong key, and a mangled token.
    let exp = chrono::Utc::now().timestamp() + 600;
    let id_like = mock.sign(json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB, "exp": exp}), false);
    let id_with_scope = mock.sign(
        json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB, "scope": "openid", "exp": exp}),
        false,
    );
    let logout_typed = mock.sign_typed(
        "logout+jwt",
        json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB, "scope": "openid", "exp": exp}),
        false,
    );
    let other_client = mock.sign_typed(
        "at+jwt",
        json!({"iss": mock.issuer, "aud": CLIENT_ID, "client_id": "koremind", "sub": SUB,
               "scope": "openid", "exp": exp}),
        false,
    );
    let forged = mock.sign_typed(
        "at+jwt",
        json!({"iss": mock.issuer, "aud": CLIENT_ID, "sub": SUB, "scope": "openid", "exp": exp}),
        true,
    );
    for bad in [
        mock.access_token(SUB, "koremind", 600),
        mock.access_token(SUB, CLIENT_ID, -3600),
        mock.access_token("someone-else", CLIENT_ID, 600),
        id_like,
        id_with_scope,
        logout_typed,
        other_client,
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
    assert_eq!(body["accountUrl"], format!("{}/account", mock.issuer));
    assert_eq!(body["apps"], json!({"kore": "https://files.example"}));

    // The operator token as a bearer, for scripts and AI agents, still works.
    let (status, _) = send(&app, request("GET", "/api/v1/monitors", Some(&h.token), None)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn anyone_kore_id_admits_gets_an_account_by_default() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &[], &[])).await;
    let session = sign_in_via_sso(&h, &mock, "new.person@office.kz").await;
    let (status, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["account"]["email"], "new.person@office.kz");
    let sub: Option<String> = sqlx::query_scalar("SELECT kore_sub FROM users").fetch_one(&h.pool).await.unwrap();
    assert_eq!(sub.as_deref(), Some(SUB));

    // KORE_ID_AUTO_PROVISION=false: a new identity is refused...
    let mut off = kore(&mock, &[], &[]);
    off.auto_provision = false;
    let h = harness_with_sso(off.clone()).await;
    let s = start(&h, "/").await;
    identity(&mock, &s, "new.person@office.kz");
    let (location, session) = callback(&h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/sign-in?sso_error=denied");
    assert!(session.is_none());
    // ...unless the optional allowlist names it.
    off.allowed_subs = vec![SUB.into()];
    let h = harness_with_sso(off).await;
    sign_in_via_sso(&h, &mock, "new.person@office.kz").await;
}

#[tokio::test]
async fn an_email_allowlist_filters_and_needs_a_verified_email() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &["ana@office.kz"], &[])).await;
    let s = start(&h, "/").await;
    identity(&mock, &s, "ana@office.kz");
    mock.next.lock().unwrap().unverified = true;
    let (location, _) = callback(&h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/sign-in?sso_error=denied");
    sign_in_via_sso(&h, &mock, "ana@office.kz").await;
}

#[tokio::test]
async fn linking_by_email_needs_email_verified() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &[], &[])).await;
    let local = common::add_member(&h, "ana@office.kz", "Ana", "correct horse").await;

    // Unverified: the local account is not taken over, and no duplicate is made.
    let s = start(&h, "/").await;
    identity(&mock, &s, "ana@office.kz");
    mock.next.lock().unwrap().unverified = true;
    let (location, session) = callback(&h, &s, "good-code", Some(&s.binding_cookie)).await;
    assert_eq!(location, "/sign-in?sso_error=denied");
    assert!(session.is_none());
    let tied: Option<String> = sqlx::query_scalar("SELECT kore_sub FROM users WHERE id = ?")
        .bind(local).fetch_one(&h.pool).await.unwrap();
    assert!(tied.is_none());

    // Verified (what Kore ID sends): linked.
    let session = sign_in_via_sso(&h, &mock, "ana@office.kz").await;
    let (_, body) = send(&h.app, with_cookie("GET", "/api/v1/auth/me", &session, None)).await;
    assert_eq!(body["account"]["id"].as_i64().unwrap(), local);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&h.pool).await.unwrap();
    assert_eq!(count, 1);
}

async fn post_logout(h: &Harness, body: &str) -> (StatusCode, Value) {
    use tower::ServiceExt;
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/api/v1/auth/sso/backchannel-logout")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let response = h.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn form(token: &str) -> String {
    format!("logout_token={}", url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>())
}

async fn me(h: &Harness, session: &str) -> StatusCode {
    send(&h.app, with_cookie("GET", "/api/v1/auth/me", session, None)).await.0
}

#[tokio::test]
async fn sign_in_keeps_the_kore_id_sid() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &[], &[])).await;
    sign_in_via_sso_with(&h, &mock, "ana@office.kz", |n| n.sid = "sid-abc".into()).await;
    let sids: Vec<Option<String>> = sqlx::query_scalar("SELECT sso_sid FROM sessions")
        .fetch_all(&h.pool).await.unwrap();
    assert_eq!(sids, [Some("sid-abc".to_string())]);
}

#[tokio::test]
async fn back_channel_logout_ends_the_sessions_of_that_sid() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &[], &[])).await;
    let laptop = sign_in_via_sso_with(&h, &mock, "ana@office.kz", |n| n.sid = "sid-laptop".into()).await;
    let phone = sign_in_via_sso_with(&h, &mock, "ana@office.kz", |n| n.sid = "sid-phone".into()).await;
    common::add_member(&h, "bo@office.kz", "Bo", "correct horse").await;
    let local = common::sign_in(&h.app, json!({"email": "bo@office.kz", "password": "correct horse"})).await;
    let laptop_bearer = mock.access_token_in(SUB, CLIENT_ID, 600, "sid-laptop");
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&laptop_bearer), None)).await;
    assert_eq!(status, StatusCode::OK);

    let token = mock.logout_token(mock.logout_claims(Some("sid-laptop"), Some(SUB)));
    let (status, body) = post_logout(&h, &form(&token)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(me(&h, &laptop).await, StatusCode::UNAUTHORIZED);
    assert_eq!(me(&h, &phone).await, StatusCode::OK, "another Kore ID session stays");
    assert_eq!(me(&h, &local).await, StatusCode::OK, "password sessions are untouched");
    // The ended Kore ID session's access tokens stop working too.
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&laptop_bearer), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let phone_bearer = mock.access_token_in(SUB, CLIENT_ID, 600, "sid-phone");
    let (status, _) = send(&h.app, request("GET", "/api/v1/auth/me", Some(&phone_bearer), None)).await;
    assert_eq!(status, StatusCode::OK);

    // The same token again is a replay.
    let (status, body) = post_logout(&h, &form(&token)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");

    // A token with only `sub` ends every Kore ID session of that account.
    let token = mock.logout_token(mock.logout_claims(None, Some(SUB)));
    let (status, _) = post_logout(&h, &form(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me(&h, &phone).await, StatusCode::UNAUTHORIZED);
    assert_eq!(me(&h, &local).await, StatusCode::OK);

    // An unknown sid is still a valid notification: 200, nothing to end.
    let token = mock.logout_token(mock.logout_claims(Some("sid-unknown"), None));
    assert_eq!(post_logout(&h, &form(&token)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn invalid_logout_tokens_are_refused() {
    let mock = provider().await;
    let h = harness_with_sso(kore(&mock, &[], &[])).await;
    let session = sign_in_via_sso(&h, &mock, "ana@office.kz").await;

    let base = || mock.logout_claims(Some("sid-1"), Some(SUB));
    let mut cases: Vec<(&str, String)> = Vec::new();
    cases.push(("typ JWT", mock.sign(base(), false)));
    cases.push(("typ at+jwt", mock.sign_typed("at+jwt", base(), false)));
    cases.push(("wrong key", mock.sign_typed("logout+jwt", base(), true)));
    let tamper = |edit: &dyn Fn(&mut Value)| {
        let mut claims = base();
        edit(&mut claims);
        mock.logout_token(claims)
    };
    cases.push(("other audience", tamper(&|c| c["aud"] = json!("koremind"))));
    cases.push(("other issuer", tamper(&|c| c["iss"] = json!("https://evil.example"))));
    cases.push(("expired", tamper(&|c| c["exp"] = json!(chrono::Utc::now().timestamp() - 3600))));
    cases.push(("no events", tamper(&|c| { c.as_object_mut().unwrap().remove("events"); })));
    cases.push(("other event", tamper(&|c| c["events"] = json!({"urn:other": {}}))));
    cases.push(("nonce", tamper(&|c| c["nonce"] = json!("n"))));
    cases.push(("no jti", tamper(&|c| { c.as_object_mut().unwrap().remove("jti"); })));
    cases.push(("no iat", tamper(&|c| { c.as_object_mut().unwrap().remove("iat"); })));
    cases.push(("no sid or sub", mock.logout_token(mock.logout_claims(None, None))));
    cases.push(("not a jwt", "garbage".into()));
    for (what, token) in cases {
        let (status, _) = post_logout(&h, &form(&token)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}");
    }
    assert_eq!(post_logout(&h, "").await.0, StatusCode::BAD_REQUEST, "no logout_token");
    assert_eq!(me(&h, &session).await, StatusCode::OK, "nothing ended");

    // With SSO off the endpoint refuses everything.
    let off = harness().await;
    let token = mock.logout_token(base());
    assert_eq!(post_logout(&off, &form(&token)).await.0, StatusCode::BAD_REQUEST);
}
