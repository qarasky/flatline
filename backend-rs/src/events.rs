//! Live event fan-out for SSE.
//!
//! Process-local broadcast with bounded streams, mirroring the Node
//! backend's rules: at most 8 streams per token and 128 in total, and a
//! slow client is dropped rather than queued (the broadcast receiver lag
//! error is the backpressure signal).
//!
//! Events are serialized once at publish time and broadcast as a shared
//! [`LiveEvent`]: every subscriber used to deep-clone the JSON value (up to
//! 64 KB for a metrics sample) and re-serialize it, once per open stream.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::broadcast;

/// Per-token stream cap, same as the Node backend.
const MAX_PER_KEY: usize = 8;
/// Instance-wide stream cap.
const MAX_TOTAL: usize = 128;
/// Broadcast ring size. At 100 agents pushing 1 Hz telemetry plus their
/// heartbeats, 256 slots were about 2.5 s of slack before a briefly busy
/// stream lagged and was closed; 4096 is ~40 s. Slots hold `Arc`s, so the
/// ring itself costs a few tens of KB.
const CHANNEL_CAPACITY: usize = 4096;

/// One published event, serialized once and shared by every subscriber.
#[derive(Debug)]
pub struct LiveEvent {
    /// The event's `type` field (`invalidate`, `heartbeat`, `metrics`, ...).
    kind: String,
    /// The serialized JSON, exactly what goes into the SSE `data:` line.
    data: Arc<str>,
}

impl LiveEvent {
    fn new(event: &Value) -> Self {
        Self {
            kind: event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            data: Arc::from(event.to_string()),
        }
    }

    /// The event's `type` field; empty when it had none.
    pub fn kind(&self) -> &str {
        &self.kind
    }

    /// The serialized JSON payload.
    pub fn data(&self) -> &str {
        &self.data
    }

    /// Parse the payload back into JSON (tests and diagnostics; the stream
    /// forwards [`data`](Self::data) untouched).
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.data).unwrap_or(Value::Null)
    }
}

pub struct Events {
    tx: broadcast::Sender<Arc<LiveEvent>>,
    counts: Mutex<HashMap<String, usize>>,
}

/// Holds one stream slot; dropping it (client disconnect, stream end)
/// releases the slot.
pub struct StreamGuard {
    events: Arc<Events>,
    key: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let mut counts = self.events.counts.lock().unwrap();
        if let Some(count) = counts.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

impl Events {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        Arc::new(Self {
            tx,
            counts: Mutex::new(HashMap::new()),
        })
    }

    /// Publish an event; no receivers is not an error. With no receivers
    /// the event is not even serialized.
    pub fn publish(&self, event: Value) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        let _ = self.tx.send(Arc::new(LiveEvent::new(&event)));
    }

    /// Convenience for the most common event.
    pub fn invalidate(&self) {
        self.publish(serde_json::json!({ "type": "invalidate" }));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<LiveEvent>> {
        self.tx.subscribe()
    }

    /// Reserve a stream slot, or None when a cap is hit (caller answers 429).
    pub fn try_open(self: &Arc<Self>, key: &str) -> Option<StreamGuard> {
        let mut counts = self.counts.lock().unwrap();
        let total: usize = counts.values().sum();
        let count = counts.get(key).copied().unwrap_or(0);

        if count >= MAX_PER_KEY || total >= MAX_TOTAL {
            return None;
        }

        counts.insert(key.to_string(), count + 1);
        Some(StreamGuard {
            events: Arc::clone(self),
            key: key.to_string(),
        })
    }

    /// Open stream count, for tests.
    #[cfg(test)]
    pub fn open_streams(&self) -> usize {
        self.counts.lock().unwrap().values().sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_limits_are_enforced_and_released() {
        let events = Events::new();

        let mut guards = Vec::new();
        for _ in 0..MAX_PER_KEY {
            guards.push(events.try_open("key-a").expect("within per-key cap"));
        }
        assert!(events.try_open("key-a").is_none(), "per-key cap must hold");

        // Hold the other key's guard: a temporary would release the slot
        // immediately and make the count assertion lie.
        let other = events.try_open("key-b").expect("other keys unaffected");
        assert_eq!(events.open_streams(), MAX_PER_KEY + 1);

        guards.pop();
        let reopened = events
            .try_open("key-a")
            .expect("dropped guard releases the slot");
        drop(reopened);
        drop(other);
        assert_eq!(events.open_streams(), MAX_PER_KEY - 1);
    }

    #[test]
    fn events_are_serialized_once_and_shared() {
        let events = Events::new();
        let mut first = events.subscribe();
        let mut second = events.subscribe();

        events.publish(serde_json::json!({ "type": "metrics", "monitorId": 7 }));
        let a = first.try_recv().unwrap();
        let b = second.try_recv().unwrap();
        assert!(
            Arc::ptr_eq(&a, &b),
            "subscribers share one serialized event"
        );
        assert_eq!(a.kind(), "metrics");
        assert_eq!(a.json()["monitorId"], 7);
        assert_eq!(a.data(), r#"{"monitorId":7,"type":"metrics"}"#);
    }
}
