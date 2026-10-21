//! Pending "sign in with a QR code" requests.
//!
//! A screen with no session asks to sign in and shows the request `code` as
//! a QR code. A phone that is already signed in approves the code; the
//! screen, which alone knows the private poll secret, then collects a token.
//! Everything lives in memory: a restart drops pending requests, which only
//! costs the waiting screen one fresh QR code. The token itself is minted by
//! the HTTP layer on first delivery and handed back here for retries.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rand::Rng;

use crate::auth::hash_token;

/// How long a request may wait for approval and pickup.
pub const REQUEST_TTL: Duration = Duration::from_secs(300);
/// After the token is first delivered, a lost response may be retried this long.
pub const DELIVERY_RETRY: Duration = Duration::from_secs(60);
/// Live requests the instance holds at once; `start` is refused beyond this.
pub const MAX_PENDING: usize = 64;
/// Longest screen name, in characters.
pub const MAX_NAME_CHARS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceError {
    /// The instance already holds `MAX_PENDING` live requests.
    Full,
    /// No live request has this code.
    Unknown,
    /// The request was already approved, denied or has expired.
    NotPending,
    /// The screen name is empty or longer than `MAX_NAME_CHARS`.
    BadName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedRequest {
    pub code: String,
    pub poll_secret: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestInfo {
    pub user_agent: String,
    pub age_seconds: u64,
    pub status: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Pending,
    Denied,
    /// Expired, unknown, or the poll secret did not match: indistinguishable.
    Expired,
    /// Approved. `delivered` holds the token once it has been minted.
    Approved {
        name: String,
        delivered: Option<String>,
    },
}

enum State {
    Pending,
    Approved {
        name: String,
        delivered: Option<(String, Instant)>,
    },
    Denied,
}

struct Entry {
    secret_hash: String,
    user_agent: String,
    created: Instant,
    state: State,
}

impl Entry {
    fn live(&self, now: Instant) -> bool {
        if let State::Approved {
            delivered: Some((_, at)),
            ..
        } = &self.state
        {
            return now.duration_since(*at) < DELIVERY_RETRY;
        }
        now.duration_since(self.created) < REQUEST_TTL
    }
}

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

pub struct DeviceRequests {
    now: Clock,
    entries: Mutex<HashMap<String, Entry>>,
}

impl Default for DeviceRequests {
    fn default() -> Self {
        Self::new()
    }
}

fn random_hex() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

impl DeviceRequests {
    pub fn new() -> Self {
        Self::new_with_clock(Arc::new(Instant::now))
    }

    pub fn new_with_clock(now: Clock) -> Self {
        Self {
            now,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn locked(&self) -> (Instant, std::sync::MutexGuard<'_, HashMap<String, Entry>>) {
        let now = (self.now)();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| entry.live(now));
        (now, entries)
    }

    pub fn start(&self, user_agent: &str) -> Result<StartedRequest, DeviceError> {
        let (now, mut entries) = self.locked();
        if entries.len() >= MAX_PENDING {
            return Err(DeviceError::Full);
        }
        let code = random_hex();
        let poll_secret = random_hex();
        entries.insert(
            code.clone(),
            Entry {
                secret_hash: hash_token(&poll_secret),
                user_agent: user_agent.chars().take(300).collect(),
                created: now,
                state: State::Pending,
            },
        );
        Ok(StartedRequest {
            code,
            poll_secret,
            expires_in: REQUEST_TTL.as_secs(),
        })
    }

    pub fn lookup(&self, code: &str) -> Result<RequestInfo, DeviceError> {
        let (now, entries) = self.locked();
        let entry = entries.get(code).ok_or(DeviceError::Unknown)?;
        Ok(RequestInfo {
            user_agent: entry.user_agent.clone(),
            age_seconds: now.duration_since(entry.created).as_secs(),
            status: match entry.state {
                State::Pending => "pending",
                State::Approved { .. } => "approved",
                State::Denied => "denied",
            },
        })
    }

    pub fn approve(&self, code: &str, name: &str) -> Result<(), DeviceError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(DeviceError::BadName);
        }
        let (_, mut entries) = self.locked();
        let entry = entries.get_mut(code).ok_or(DeviceError::NotPending)?;
        if !matches!(entry.state, State::Pending) {
            return Err(DeviceError::NotPending);
        }
        entry.state = State::Approved {
            name: name.to_string(),
            delivered: None,
        };
        Ok(())
    }

    pub fn deny(&self, code: &str) -> Result<(), DeviceError> {
        let (_, mut entries) = self.locked();
        let entry = entries.get_mut(code).ok_or(DeviceError::NotPending)?;
        if !matches!(entry.state, State::Pending) {
            return Err(DeviceError::NotPending);
        }
        entry.state = State::Denied;
        Ok(())
    }

    pub fn poll(&self, code: &str, poll_secret: &str) -> PollOutcome {
        let (_, entries) = self.locked();
        let Some(entry) = entries.get(code) else {
            return PollOutcome::Expired;
        };
        if entry.secret_hash != hash_token(poll_secret) {
            return PollOutcome::Expired;
        }
        match &entry.state {
            State::Pending => PollOutcome::Pending,
            State::Denied => PollOutcome::Denied,
            State::Approved { name, delivered } => PollOutcome::Approved {
                name: name.clone(),
                delivered: delivered.as_ref().map(|(token, _)| token.clone()),
            },
        }
    }

    /// Remember the minted token so a lost response can be retried.
    pub fn record_delivery(&self, code: &str, token: &str) {
        let (now, mut entries) = self.locked();
        if let Some(Entry {
            state: State::Approved { delivered, .. },
            ..
        }) = entries.get_mut(code)
        {
            *delivered = Some((token.to_string(), now));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store with a clock the test moves by hand.
    fn store() -> (DeviceRequests, Arc<Mutex<Duration>>) {
        let base = Instant::now();
        let offset = Arc::new(Mutex::new(Duration::ZERO));
        let clock_offset = Arc::clone(&offset);
        let requests =
            DeviceRequests::new_with_clock(Arc::new(move || base + *clock_offset.lock().unwrap()));
        (requests, offset)
    }

    fn advance(offset: &Arc<Mutex<Duration>>, by: Duration) {
        *offset.lock().unwrap() += by;
    }

    #[test]
    fn start_returns_distinct_code_and_secret() {
        let (requests, _) = store();
        let a = requests.start("ua").unwrap();
        let b = requests.start("ua").unwrap();
        assert_ne!(a.code, a.poll_secret);
        assert_ne!(a.code, b.code);
        assert_eq!(a.expires_in, 300);
    }

    #[test]
    fn lookup_reports_age_and_status() {
        let (requests, offset) = store();
        let started = requests.start("Mozilla Chrome").unwrap();
        advance(&offset, Duration::from_secs(20));
        let info = requests.lookup(&started.code).unwrap();
        assert_eq!(info.user_agent, "Mozilla Chrome");
        assert_eq!(info.age_seconds, 20);
        assert_eq!(info.status, "pending");
        assert_eq!(requests.lookup("nope"), Err(DeviceError::Unknown));
    }

    #[test]
    fn approve_then_second_approve_is_not_pending() {
        let (requests, _) = store();
        let started = requests.start("ua").unwrap();
        assert_eq!(requests.approve(&started.code, "TV"), Ok(()));
        assert_eq!(
            requests.approve(&started.code, "TV"),
            Err(DeviceError::NotPending)
        );
    }

    #[test]
    fn approve_after_deny_is_not_pending() {
        let (requests, _) = store();
        let started = requests.start("ua").unwrap();
        requests.deny(&started.code).unwrap();
        assert_eq!(
            requests.approve(&started.code, "TV"),
            Err(DeviceError::NotPending)
        );
        assert_eq!(
            requests.poll(&started.code, &started.poll_secret),
            PollOutcome::Denied
        );
    }

    #[test]
    fn approve_after_expiry_is_not_pending() {
        let (requests, offset) = store();
        let started = requests.start("ua").unwrap();
        advance(&offset, REQUEST_TTL);
        assert_eq!(
            requests.approve(&started.code, "TV"),
            Err(DeviceError::NotPending)
        );
    }

    #[test]
    fn wrong_poll_secret_looks_expired() {
        let (requests, _) = store();
        let started = requests.start("ua").unwrap();
        requests.approve(&started.code, "TV").unwrap();
        assert_eq!(requests.poll(&started.code, "wrong"), PollOutcome::Expired);
        assert_eq!(
            requests.poll(&started.code, &started.code),
            PollOutcome::Expired
        );
    }

    #[test]
    fn unknown_code_looks_expired() {
        let (requests, _) = store();
        assert_eq!(requests.poll("nope", "nope"), PollOutcome::Expired);
    }

    #[test]
    fn poll_after_approve_returns_name_without_delivery_until_recorded() {
        let (requests, _) = store();
        let started = requests.start("ua").unwrap();
        assert_eq!(
            requests.poll(&started.code, &started.poll_secret),
            PollOutcome::Pending
        );
        requests
            .approve(&started.code, "  Living room TV ")
            .unwrap();
        assert_eq!(
            requests.poll(&started.code, &started.poll_secret),
            PollOutcome::Approved {
                name: "Living room TV".to_string(),
                delivered: None
            }
        );
    }

    #[test]
    fn recorded_delivery_is_returned_again_within_60s() {
        let (requests, offset) = store();
        let started = requests.start("ua").unwrap();
        requests.approve(&started.code, "TV").unwrap();
        requests.record_delivery(&started.code, "tok");
        advance(&offset, Duration::from_secs(59));
        assert_eq!(
            requests.poll(&started.code, &started.poll_secret),
            PollOutcome::Approved {
                name: "TV".to_string(),
                delivered: Some("tok".to_string())
            }
        );
    }

    #[test]
    fn recorded_delivery_is_gone_after_60s() {
        let (requests, offset) = store();
        let started = requests.start("ua").unwrap();
        requests.approve(&started.code, "TV").unwrap();
        requests.record_delivery(&started.code, "tok");
        advance(&offset, DELIVERY_RETRY);
        assert_eq!(
            requests.poll(&started.code, &started.poll_secret),
            PollOutcome::Expired
        );
    }

    #[test]
    fn start_is_refused_at_cap() {
        let (requests, offset) = store();
        for _ in 0..MAX_PENDING {
            requests.start("ua").unwrap();
        }
        assert_eq!(requests.start("ua"), Err(DeviceError::Full));
        advance(&offset, REQUEST_TTL);
        assert!(requests.start("ua").is_ok());
    }

    #[test]
    fn name_is_trimmed_and_bounded() {
        let (requests, _) = store();
        let started = requests.start("ua").unwrap();
        assert_eq!(
            requests.approve(&started.code, "   "),
            Err(DeviceError::BadName)
        );
        assert_eq!(
            requests.approve(&started.code, &"x".repeat(61)),
            Err(DeviceError::BadName)
        );
        assert_eq!(requests.approve(&started.code, &"x".repeat(60)), Ok(()));
    }
}
