//! Kore ID single sign-on (OpenID Connect, authorization code + PKCE).
//!
//! The backend is the relying party: it owns the sessions, the accounts and
//! the cookies, so the whole flow lives here and the web app only links to
//! `/api/v1/auth/sso/start`. A successful callback ends in the same
//! `fl_session` cookie email/password sign-in produces.
//!
//! What is verified, and nothing is taken on trust from the browser:
//! - `state` is a one-time server-side record, bound to the browser that
//!   started the flow by a random `fl_sso` cookie (login-CSRF defence);
//! - PKCE `S256` verifier and `nonce` are generated per attempt;
//! - the id token's EdDSA signature is checked against the provider's JWKS
//!   (any other `alg`, including `none`, is refused), plus `iss`, `aud`,
//!   `exp`, `nbf` and `nonce`;
//! - a Kore ID access token presented as a bearer is verified the same way
//!   (audience = this app's client id), must have the RFC 9068 header
//!   `typ: at+jwt` (so an id or logout token is never a credential), and
//!   must belong to an account that already signed in through SSO;
//! - a back-channel logout token (OIDC Back-Channel Logout 1.0) must have
//!   `typ: logout+jwt`, the logout `events` claim, no `nonce`, a `sid` or
//!   `sub`, and a `jti` not seen before (kept until the token's `exp`).
//!
//! The pending sign-in attempts, the `jti` replay cache and the recently
//! ended Kore ID sessions live in memory: Flatline runs as one backend
//! process, and a restart only fails sign-ins that were in flight.
//!
//! Identity is the `sub` claim, the same UUID in every Kore app. Who may
//! get an account is decided by [`crate::accounts::sso_sign_in`].

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use rand::Rng;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::KoreIdConfig;

/// The cookie that binds a callback to the browser that started the flow.
pub const SSO_COOKIE: &str = "fl_sso";
/// Where the cookie is sent: only the SSO endpoints.
const SSO_COOKIE_PATH: &str = "/api/v1/auth/sso";
/// How long a sign-in attempt may take, from redirect to callback.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Pending attempts kept; beyond it the oldest are dropped.
const PENDING_CAP: usize = 2048;
/// How long discovery and the key set are reused.
const METADATA_TTL: Duration = Duration::from_secs(60 * 60);
/// An unknown `kid` refetches the key set at most this often.
const JWKS_REFETCH_MIN: Duration = Duration::from_secs(30);
/// Clock skew tolerated on `exp` and `nbf`.
const LEEWAY_SECONDS: i64 = 60;
/// Scopes requested: identity only. No refresh tokens are asked for.
const SCOPES: &str = "openid profile email";
/// The `events` member every logout token carries.
pub const BACKCHANNEL_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";
/// How long a Kore ID session ended by back-channel logout keeps refusing
/// its access tokens: longer than their 10-minute lifetime.
const ENDED_SID_TTL: Duration = Duration::from_secs(15 * 60);
/// Remembered logout `jti`s and ended `sid`s, beyond which the oldest go.
const LOGOUT_CACHE_CAP: usize = 4096;

/// Why an SSO step failed. The variant picks the message shown on the
/// sign-in page ([`SsoError::code`]); the detail goes to the log only.
#[derive(Debug)]
pub enum SsoError {
    /// Unknown, expired or replayed `state`, or the binding cookie is missing.
    State,
    /// The provider answered with an error (the user cancelled, say).
    Provider(String),
    /// The provider could not be reached or answered nonsense.
    Unavailable(String),
    /// The token failed verification.
    Token(String),
}

impl SsoError {
    /// A short stable code for `/sign-in?sso_error=`.
    pub fn code(&self) -> &'static str {
        match self {
            SsoError::State => "state",
            SsoError::Provider(_) => "provider",
            SsoError::Unavailable(_) => "unavailable",
            SsoError::Token(_) => "token",
        }
    }
}

/// The verified claims this app uses.
#[derive(Debug, Clone)]
pub struct Claims {
    pub sub: String,
    pub email: Option<String>,
    pub email_verified: Option<bool>,
    pub name: Option<String>,
    /// The `scope` claim; access tokens carry it, id tokens do not.
    pub scope: Option<String>,
    /// The Kore ID session (`sid`) the token was issued in.
    pub sid: Option<String>,
}

/// Which local sessions a verified back-channel logout token ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogoutTarget {
    /// Every session made from this Kore ID session.
    Sid(String),
    /// Every Kore ID session of this subject (the token had no `sid`).
    Sub(String),
}

/// The result of a completed sign-in.
#[derive(Debug)]
pub struct Identity {
    pub claims: Claims,
    /// Kept with the session as the logout hint.
    pub id_token: String,
    /// The local path to land on.
    pub next: String,
}

#[derive(Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    #[serde(default)]
    end_session_endpoint: Option<String>,
}

struct Pending {
    verifier: String,
    nonce: String,
    binding: String,
    next: String,
    created: Instant,
}

#[derive(Default)]
struct Keys {
    fetched: Option<Instant>,
    attempted: Option<Instant>,
    by_kid: HashMap<String, VerifyingKey>,
}

/// The relying-party runtime: configuration plus the caches.
pub struct Sso {
    pub config: KoreIdConfig,
    http: reqwest::Client,
    discovery: tokio::sync::Mutex<Option<(Instant, Discovery)>>,
    keys: tokio::sync::Mutex<Keys>,
    pending: Mutex<HashMap<String, Pending>>,
    /// Logout token `jti` -> its `exp` (unix seconds): replay defence.
    seen_logout: Mutex<HashMap<String, i64>>,
    /// Kore ID sessions ended by back-channel logout, so their still-unexpired
    /// access tokens stop working too.
    ended_sids: Mutex<HashMap<String, Instant>>,
}

fn random_url_safe(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn unavailable(what: &str, error: impl std::fmt::Display) -> SsoError {
    SsoError::Unavailable(format!("{what}: {error}"))
}

/// A local path safe to redirect to after sign-in: one slash, no authority,
/// no backslash or control characters. Anything else becomes `/`.
pub fn safe_next(raw: Option<&str>) -> String {
    match raw {
        Some(next)
            if next.starts_with('/')
                && !next.starts_with("//")
                && !next.starts_with("/sign-in")
                && !next.chars().any(|c| c == '\\' || c.is_control()) =>
        {
            next.to_string()
        }
        _ => "/".to_string(),
    }
}

/// Whether a bearer value has the shape of a JWT (three dot-separated parts
/// starting with a base64url JSON object), so operator and agent tokens
/// never reach the JWT path.
pub fn looks_like_jwt(token: &str) -> bool {
    token.starts_with("eyJ") && token.bytes().filter(|b| *b == b'.').count() == 2
}

impl Sso {
    pub fn new(config: KoreIdConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("an HTTP client builds with default TLS");
        Self {
            config,
            http,
            discovery: tokio::sync::Mutex::new(None),
            keys: tokio::sync::Mutex::new(Keys::default()),
            pending: Mutex::new(HashMap::new()),
            seen_logout: Mutex::new(HashMap::new()),
            ended_sids: Mutex::new(HashMap::new()),
        }
    }

    async fn discover(&self) -> Result<Discovery, SsoError> {
        let mut slot = self.discovery.lock().await;
        if let Some((at, found)) = slot.as_ref()
            && at.elapsed() < METADATA_TTL
        {
            return Ok(found.clone());
        }
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.config.issuer.trim_end_matches('/')
        );
        let found: Discovery = self
            .http
            .get(&url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| unavailable("discovery", e))?
            .json()
            .await
            .map_err(|e| unavailable("discovery body", e))?;
        if found.issuer.trim_end_matches('/') != self.config.issuer.trim_end_matches('/') {
            return Err(SsoError::Unavailable(format!(
                "discovery issuer {:?} does not match KORE_ID_ISSUER",
                found.issuer
            )));
        }
        *slot = Some((Instant::now(), found.clone()));
        Ok(found)
    }

    /// Begin a sign-in: the provider URL to send the browser to, and the
    /// binding cookie value to set.
    pub async fn start(&self, next: Option<&str>) -> Result<(String, String), SsoError> {
        let discovery = self.discover().await?;
        let state = random_url_safe(32);
        let nonce = random_url_safe(32);
        let verifier = random_url_safe(48);
        let binding = random_url_safe(32);

        let mut url = reqwest::Url::parse(&discovery.authorization_endpoint)
            .map_err(|e| unavailable("authorization_endpoint", e))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", &self.config.redirect_uri)
            .append_pair("scope", SCOPES)
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &pkce_challenge(&verifier))
            .append_pair("code_challenge_method", "S256");

        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.created.elapsed() < PENDING_TTL);
        if pending.len() >= PENDING_CAP
            && let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(key, _)| key.clone())
        {
            pending.remove(&oldest);
        }
        pending.insert(
            state,
            Pending {
                verifier,
                nonce,
                binding: binding.clone(),
                next: safe_next(next),
                created: Instant::now(),
            },
        );
        Ok((url.to_string(), binding))
    }

    /// Finish a sign-in from the callback's query and the binding cookie.
    pub async fn finish(
        &self,
        code: &str,
        state: &str,
        binding: Option<&str>,
    ) -> Result<Identity, SsoError> {
        // One use: the record is removed whether or not the rest succeeds.
        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(state)
            .ok_or(SsoError::State)?;
        let bound = binding.is_some_and(|cookie| constant_time_eq(cookie, &pending.binding));
        if pending.created.elapsed() >= PENDING_TTL || !bound {
            return Err(SsoError::State);
        }

        let discovery = self.discover().await?;
        let mut form: Vec<(&str, &str)> = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &self.config.redirect_uri),
            ("code_verifier", &pending.verifier),
        ];
        let mut request = self
            .http
            .post(&discovery.token_endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json");
        match (&self.config.client_secret, self.config.client_auth_post) {
            (Some(secret), false) => {
                let enc = |v: &str| url::form_urlencoded::byte_serialize(v.as_bytes()).collect::<String>();
                let pair = format!("{}:{}", enc(&self.config.client_id), enc(secret));
                request = request.header(
                    "authorization",
                    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair)),
                );
            }
            (Some(secret), true) => {
                form.push(("client_id", &self.config.client_id));
                form.push(("client_secret", secret));
            }
            (None, _) => {
                form.push(("client_id", &self.config.client_id));
            }
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form)
            .finish();
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|e| unavailable("token request", e))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| unavailable("token response", e))?;
        if !status.is_success() {
            return Err(SsoError::Provider(format!(
                "token endpoint {status}: {}",
                body.get("error").and_then(Value::as_str).unwrap_or("error")
            )));
        }
        let id_token = body
            .get("id_token")
            .and_then(Value::as_str)
            .ok_or_else(|| SsoError::Token("the token response has no id_token".into()))?
            .to_string();
        let (header, claims) = self.verify_signature(&id_token).await?;
        // An id token is a plain JWT; one typed as an access or logout token
        // is not an id token.
        if typ_is(&header, "at+jwt") || typ_is(&header, "logout+jwt") {
            return Err(SsoError::Token("the id_token is typed as another kind of token".into()));
        }
        let claims = check_claims(
            &claims,
            &self.config.issuer,
            &self.config.client_id,
            Some(&pending.nonce),
        )?;
        Ok(Identity {
            claims,
            id_token,
            next: pending.next,
        })
    }

    /// Verify a Kore ID access token used as a bearer: header
    /// `typ: at+jwt` (RFC 9068), so an id token or a logout token is never
    /// an API credential; issued to this client (`aud`, and `client_id`
    /// when present); with a `scope`; and not from a Kore ID session that
    /// back-channel logout already ended.
    pub async fn verify_access_token(&self, token: &str) -> Result<Claims, SsoError> {
        let (header, raw) = self.verify_signature(token).await?;
        if !typ_is(&header, "at+jwt") {
            return Err(SsoError::Token("not an access token (typ is not at+jwt)".into()));
        }
        if let Some(client_id) = raw.get("client_id")
            && client_id.as_str() != Some(self.config.client_id.as_str())
        {
            return Err(SsoError::Token("access token for another client".into()));
        }
        let claims = check_claims(&raw, &self.config.issuer, &self.config.client_id, None)?;
        if claims.scope.is_none() {
            return Err(SsoError::Token("not an access token (no scope claim)".into()));
        }
        if let Some(sid) = &claims.sid
            && self.sid_ended(sid)
        {
            return Err(SsoError::Token("the Kore ID session has ended".into()));
        }
        Ok(claims)
    }

    /// Verify a back-channel logout token (OIDC Back-Channel Logout 1.0,
    /// section 2.6): signature, `iss`, `aud` (this client), `iat`, `exp`,
    /// header `typ: logout+jwt`, the logout event in `events`, no `nonce`,
    /// a `sid` or `sub`, and a `jti` never seen before. A verified `sid` is
    /// also remembered as ended, so its access tokens stop working.
    pub async fn verify_logout_token(&self, token: &str) -> Result<LogoutTarget, SsoError> {
        let bad = |why: &str| SsoError::Token(format!("logout token: {why}"));
        let (header, claims) = self.verify_signature(token).await?;
        if !typ_is(&header, "logout+jwt") {
            return Err(bad("typ is not logout+jwt"));
        }
        check_common(&claims, &self.config.issuer, &self.config.client_id)?;
        if claims.get("iat").and_then(Value::as_i64).is_none() {
            return Err(bad("no iat"));
        }
        let exp = claims.get("exp").and_then(Value::as_i64).ok_or_else(|| bad("no exp"))?;
        let event_ok = claims
            .get("events")
            .and_then(Value::as_object)
            .and_then(|events| events.get(BACKCHANNEL_EVENT))
            .is_some_and(Value::is_object);
        if !event_ok {
            return Err(bad("no back-channel logout event"));
        }
        if claims.get("nonce").is_some() {
            return Err(bad("nonce is not allowed"));
        }
        let text = |name: &str| {
            claims
                .get(name)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let target = match (text("sid"), text("sub")) {
            (Some(sid), _) => LogoutTarget::Sid(sid),
            (None, Some(sub)) => LogoutTarget::Sub(sub),
            (None, None) => return Err(bad("neither sid nor sub")),
        };
        let jti = text("jti").ok_or_else(|| bad("no jti"))?;
        {
            let now = chrono::Utc::now().timestamp();
            let mut seen = self.seen_logout.lock().unwrap();
            seen.retain(|_, until| *until + LEEWAY_SECONDS >= now);
            if seen.contains_key(&jti) {
                return Err(bad("replayed jti"));
            }
            if seen.len() >= LOGOUT_CACHE_CAP
                && let Some(oldest) = seen.iter().min_by_key(|(_, until)| **until).map(|(k, _)| k.clone())
            {
                seen.remove(&oldest);
            }
            seen.insert(jti, exp);
        }
        if let LogoutTarget::Sid(sid) = &target {
            let mut ended = self.ended_sids.lock().unwrap();
            ended.retain(|_, at| at.elapsed() < ENDED_SID_TTL);
            if ended.len() >= LOGOUT_CACHE_CAP
                && let Some(oldest) = ended.iter().min_by_key(|(_, at)| **at).map(|(k, _)| k.clone())
            {
                ended.remove(&oldest);
            }
            ended.insert(sid.clone(), Instant::now());
        }
        Ok(target)
    }

    fn sid_ended(&self, sid: &str) -> bool {
        self.ended_sids
            .lock()
            .unwrap()
            .get(sid)
            .is_some_and(|at| at.elapsed() < ENDED_SID_TTL)
    }

    /// Where to send the browser to end the Kore ID session too, when the
    /// provider has an end-session endpoint.
    pub async fn logout_url(&self, id_token: &str) -> Option<String> {
        let endpoint = self.discover().await.ok()?.end_session_endpoint?;
        let mut url = reqwest::Url::parse(&endpoint).ok()?;
        url.query_pairs_mut()
            .append_pair("id_token_hint", id_token)
            .append_pair(
                "post_logout_redirect_uri",
                &self.config.post_logout_redirect_uri,
            );
        Some(url.to_string())
    }

    /// The signing key for `kid`, refetching the key set when it is stale or
    /// the key is unknown (rotation), but not more than once per
    /// [`JWKS_REFETCH_MIN`].
    async fn key_for(&self, kid: &str) -> Result<VerifyingKey, SsoError> {
        let mut cache = self.keys.lock().await;
        let fresh = cache.fetched.is_some_and(|at| at.elapsed() < METADATA_TTL);
        if fresh && let Some(key) = cache.by_kid.get(kid) {
            return Ok(*key);
        }
        let may_fetch = cache
            .attempted
            .is_none_or(|at| at.elapsed() >= JWKS_REFETCH_MIN);
        if may_fetch {
            cache.attempted = Some(Instant::now());
            let discovery = self.discover().await?;
            let set: Value = self
                .http
                .get(&discovery.jwks_uri)
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| unavailable("jwks", e))?
                .json()
                .await
                .map_err(|e| unavailable("jwks body", e))?;
            cache.by_kid = parse_jwks(&set);
            cache.fetched = Some(Instant::now());
        }
        cache
            .by_kid
            .get(kid)
            .copied()
            .ok_or_else(|| SsoError::Token(format!("no signing key {kid:?} at the provider")))
    }

    /// Check the EdDSA signature of a JWT against the provider's keys and
    /// return its header and claims, not yet checked.
    async fn verify_signature(&self, token: &str) -> Result<(Value, Value), SsoError> {
        let bad = |why: &str| SsoError::Token(why.to_string());
        let mut parts = token.split('.');
        let (Some(head), Some(body), Some(sig), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(bad("not a JWT"));
        };
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| bad("bad base64url"));
        let header: Value = serde_json::from_slice(&decode(head)?).map_err(|_| bad("bad header"))?;
        if header.get("alg").and_then(Value::as_str) != Some("EdDSA") {
            return Err(bad("alg must be EdDSA"));
        }
        let kid = header
            .get("kid")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("no kid"))?;
        let key = self.key_for(kid).await?;
        let signature = Signature::from_slice(&decode(sig)?).map_err(|_| bad("bad signature"))?;
        let signed = &token[..head.len() + 1 + body.len()];
        key.verify_strict(signed.as_bytes(), &signature)
            .map_err(|_| bad("signature does not verify"))?;

        let claims: Value = serde_json::from_slice(&decode(body)?).map_err(|_| bad("bad claims"))?;
        if !claims.is_object() {
            return Err(bad("claims are not an object"));
        }
        Ok((header, claims))
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Ed25519 keys of a JWKS by `kid`; other key types are ignored.
fn parse_jwks(set: &Value) -> HashMap<String, VerifyingKey> {
    let mut keys = HashMap::new();
    for jwk in set.get("keys").and_then(Value::as_array).into_iter().flatten() {
        let text = |name: &str| jwk.get(name).and_then(Value::as_str);
        if text("kty") != Some("OKP") || text("crv") != Some("Ed25519") {
            continue;
        }
        let (Some(kid), Some(x)) = (text("kid"), text("x")) else {
            continue;
        };
        let Ok(raw) = URL_SAFE_NO_PAD.decode(x) else {
            continue;
        };
        let Ok(raw) = <[u8; 32]>::try_from(raw.as_slice()) else {
            continue;
        };
        if let Ok(key) = VerifyingKey::from_bytes(&raw) {
            keys.insert(kid.to_string(), key);
        }
    }
    keys
}

/// Whether a JWT header's `typ` is `want`, compared as RFC 8725 and RFC
/// 9068 say: case-insensitive, with or without the `application/` prefix.
fn typ_is(header: &Value, want: &str) -> bool {
    header.get("typ").and_then(Value::as_str).is_some_and(|typ| {
        let typ = typ.to_ascii_lowercase();
        typ.strip_prefix("application/").unwrap_or(&typ) == want
    })
}

/// Issuer, audience, `exp` and `nbf` of a token whose signature verified.
fn check_common(claims: &Value, issuer: &str, client_id: &str) -> Result<(), SsoError> {
    let bad = |why: &str| SsoError::Token(why.to_string());
    let text = |name: &str| claims.get(name).and_then(Value::as_str);
    if text("iss").map(|iss| iss.trim_end_matches('/')) != Some(issuer.trim_end_matches('/')) {
        return Err(bad("wrong issuer"));
    }
    let audience_ok = match claims.get("aud") {
        Some(Value::String(aud)) => aud == client_id,
        Some(Value::Array(list)) => list.iter().any(|aud| aud.as_str() == Some(client_id)),
        _ => false,
    };
    if !audience_ok {
        return Err(bad("wrong audience"));
    }
    let now = chrono::Utc::now().timestamp();
    let exp = claims.get("exp").and_then(Value::as_i64).ok_or_else(|| bad("no exp"))?;
    if exp + LEEWAY_SECONDS < now {
        return Err(bad("expired"));
    }
    if let Some(nbf) = claims.get("nbf").and_then(Value::as_i64)
        && nbf - LEEWAY_SECONDS > now
    {
        return Err(bad("not yet valid"));
    }
    Ok(())
}

/// The claim checks of an id or access token whose signature verified.
fn check_claims(
    claims: &Value,
    issuer: &str,
    client_id: &str,
    nonce: Option<&str>,
) -> Result<Claims, SsoError> {
    let bad = |why: &str| SsoError::Token(why.to_string());
    let text = |name: &str| claims.get(name).and_then(Value::as_str);
    check_common(claims, issuer, client_id)?;
    if let Some(expected) = nonce
        && text("nonce") != Some(expected)
    {
        return Err(bad("nonce mismatch"));
    }
    let sub = text("sub").filter(|sub| !sub.is_empty()).ok_or_else(|| bad("no sub"))?;
    Ok(Claims {
        sub: sub.to_string(),
        email: text("email").map(str::to_string),
        email_verified: claims.get("email_verified").and_then(Value::as_bool),
        name: text("name").map(str::to_string),
        scope: text("scope").map(str::to_string),
        sid: text("sid").filter(|sid| !sid.is_empty()).map(str::to_string),
    })
}

/// `Set-Cookie` for the binding cookie.
pub fn binding_cookie(value: &str, secure: bool) -> String {
    format!(
        "{SSO_COOKIE}={value}; Max-Age={}; Path={SSO_COOKIE_PATH}; HttpOnly; SameSite=Lax{}",
        PENDING_TTL.as_secs(),
        if secure { "; Secure" } else { "" }
    )
}

/// `Set-Cookie` that clears the binding cookie.
pub fn clear_binding_cookie(secure: bool) -> String {
    format!(
        "{SSO_COOKIE}=; Max-Age=0; Path={SSO_COOKIE_PATH}; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn future() -> i64 {
        chrono::Utc::now().timestamp() + 600
    }

    #[test]
    fn next_must_be_a_local_path() {
        assert_eq!(safe_next(Some("/monitors?x=1")), "/monitors?x=1");
        for bad in ["//evil.example", "https://evil.example", "/\\evil", "/a\nb", "/sign-in", "monitors"] {
            assert_eq!(safe_next(Some(bad)), "/", "{bad}");
        }
        assert_eq!(safe_next(None), "/");
    }

    #[test]
    fn only_jwt_shaped_bearers_take_the_jwt_path() {
        assert!(looks_like_jwt("eyJhbGciOiJFZERTQSJ9.e30.c2ln"));
        assert!(!looks_like_jwt("flatline_op_abc"));
        assert!(!looks_like_jwt("eyJonly.one"));
    }

    #[test]
    fn claims_are_checked() {
        let ok = json!({"iss":"https://id.example","aud":"flatline","exp":future(),"sub":"u1","nonce":"n","email":"a@b.c"});
        let c = check_claims(&ok, "https://id.example/", "flatline", Some("n")).unwrap();
        assert_eq!(c.sub, "u1");
        assert_eq!(c.email.as_deref(), Some("a@b.c"));

        let mut wrong = ok.clone();
        wrong["iss"] = json!("https://other.example");
        assert!(check_claims(&wrong, "https://id.example", "flatline", None).is_err());
        let mut wrong = ok.clone();
        wrong["aud"] = json!("koremind");
        assert!(check_claims(&wrong, "https://id.example", "flatline", None).is_err());
        let mut wrong = ok.clone();
        wrong["aud"] = json!(["koremind", "flatline"]);
        assert!(check_claims(&wrong, "https://id.example", "flatline", None).is_ok());
        let mut wrong = ok.clone();
        wrong["exp"] = json!(chrono::Utc::now().timestamp() - 3600);
        assert!(check_claims(&wrong, "https://id.example", "flatline", None).is_err());
        assert!(check_claims(&ok, "https://id.example", "flatline", Some("other")).is_err());
        let mut wrong = ok.clone();
        wrong["sub"] = json!("");
        assert!(check_claims(&wrong, "https://id.example", "flatline", None).is_err());
    }

    #[test]
    fn typ_is_compared_like_a_media_type() {
        assert!(typ_is(&json!({"typ": "at+jwt"}), "at+jwt"));
        assert!(typ_is(&json!({"typ": "application/AT+JWT"}), "at+jwt"));
        assert!(!typ_is(&json!({"typ": "JWT"}), "at+jwt"));
        assert!(!typ_is(&json!({}), "at+jwt"));
        assert!(!typ_is(&json!({"typ": "logout+jwt"}), "at+jwt"));
    }

    #[test]
    fn pkce_challenge_matches_rfc7636() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
