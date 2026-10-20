//! Notification dispatch. Telegram is the only provider in v1 (locked
//! scope) and the one the office instance actually uses.
//!
//! Message shape matches the Node provider with templates off (the office
//! config has `telegramUseTemplate: false`): `[name] [🔴 Down] message`.
//!
//! Delivery goes through the [`Notifier`] (E3): the engine enqueues without
//! waiting, one dispatcher resolves messages in transition order, and each
//! chat has its own ordered queue drained by one worker behind a token
//! bucket. Under pressure the backlog is coalesced into one summary message
//! instead of being sent (and rate-limited away) one by one.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::heartbeats::{PENDING, UP};
use crate::monitors::Monitor;

/// A Telegram config parsed from a notification row.
#[derive(Debug, Clone)]
pub struct Telegram {
    pub server_url: String,
    pub bot_token: String,
    pub chat_id: String,
    pub disable_notification: bool,
    pub protect_content: bool,
    pub message_thread_id: Option<Value>,
}

/// Parse the `config` JSON of a notification row. A missing token or chat
/// id means the row cannot send; the caller skips it.
pub fn parse_telegram(config: &str) -> Option<Telegram> {
    let value: Value = serde_json::from_str(config).ok()?;

    let bot_token = value.get("telegramBotToken")?.as_str()?.to_string();
    let chat_id = value.get("telegramChatID")?.as_str()?.to_string();
    if bot_token.is_empty() || chat_id.is_empty() {
        return None;
    }

    Some(Telegram {
        server_url: value
            .get("telegramServerUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .unwrap_or("https://api.telegram.org")
            .trim_end_matches('/')
            .to_string(),
        bot_token,
        chat_id,
        disable_notification: value
            .get("telegramSendSilently")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        protect_content: value
            .get("telegramProtectContent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        message_thread_id: value
            .get("telegramMessageThreadID")
            .filter(|thread| !thread.is_null())
            .cloned(),
    })
}

/// The operator-requested alert shape: one bracketed field per line.
///
/// ```text
/// [🔴 DOWN] [work / MEKS] [modernization-meks]
/// [push] [modernization-meks]
/// [No heartbeat in the time window]
/// [CPU 12% · RAM 43% · Disk / 71% · Load 0.42]
/// ```
///
/// Line 4 exists for push monitors only (their last telemetry); everything
/// else is three lines.
pub struct AlertParts {
    pub name: String,
    pub kind: String,
    /// Ancestor group names, outermost first ("work / MEKS"), None at root.
    pub group: Option<String>,
    /// Check target: URL, IP/hostname, agent hostname or child count.
    pub target: Option<String>,
    pub status: i64,
    pub message: String,
    /// One-line metrics summary for push monitors.
    pub metrics: Option<String>,
}

/// Render the parts into the plain-text alert.
pub fn format_alert(parts: &AlertParts) -> String {
    let tag = match parts.status {
        UP => "✅ UP",
        PENDING => "⏳ PENDING",
        _ => "🔴 DOWN",
    };
    let group = parts.group.as_deref().unwrap_or("Ungrouped");

    let mut lines = vec![format!("[{tag}] [{group}] [{}]", parts.name)];

    let target = parts.target.as_deref().filter(|target| !target.is_empty());
    lines.push(match target {
        Some(target) => format!("[{}] [{target}]", parts.kind),
        None => format!("[{}]", parts.kind),
    });

    // Messages are single-line by contract; collapse any stray whitespace
    // so one field can never look like two.
    lines.push(format!("[{}]", single_line(&parts.message)));
    if let Some(metrics) = &parts.metrics {
        lines.push(format!("[{metrics}]"));
    }

    lines.join("\n")
}

fn single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Ancestor group names of a monitor, outermost first ("work / MEKS").
/// `None` for a root-level monitor; broken links stop the walk.
pub async fn group_path(pool: &SqlitePool, parent: Option<i64>) -> Option<String> {
    let mut names: Vec<String> = Vec::new();
    let mut cursor = parent;
    for _ in 0..64 {
        let Some(id) = cursor else { break };
        let row: Option<(String, Option<i64>)> =
            sqlx::query_as("SELECT name, parent FROM monitors WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten();
        let Some((name, next)) = row else { break };
        names.push(name);
        cursor = next;
    }
    if names.is_empty() {
        return None;
    }
    names.reverse();
    Some(names.join(" / "))
}

/// Build the alert for one heartbeat: group path, check target and — for
/// push monitors — a line of the last telemetry the agent sent.
pub async fn build_heartbeat_message(
    pool: &SqlitePool,
    monitor: &Monitor,
    status: i64,
    message: &str,
) -> String {
    let group = group_path(pool, monitor.parent).await;
    let mut target = match monitor.kind.as_str() {
        "http" | "https" | "keyword" => monitor.url.clone(),
        "ping" => monitor.hostname.clone(),
        _ => monitor.url.clone().or_else(|| monitor.hostname.clone()),
    };
    let mut metrics = None;

    match monitor.kind.as_str() {
        "group" => {
            let children: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM monitors WHERE parent = ?")
                    .bind(monitor.id)
                    .fetch_one(pool)
                    .await
                    .unwrap_or(0);
            target = Some(format!("{children} children"));
        }
        "push" => {
            if let Some(sample) = latest_sample(pool, monitor.id).await {
                let hostname = sample
                    .pointer("/host/hostname")
                    .and_then(Value::as_str)
                    .filter(|hostname| !hostname.is_empty());
                if let Some(hostname) = hostname {
                    target = Some(hostname.to_string());
                }
                metrics = metrics_line(&sample);
            }
            if target.as_deref().is_none_or(str::is_empty) {
                target = Some(monitor.name.clone());
            }
        }
        _ => {}
    }

    format_alert(&AlertParts {
        name: monitor.name.clone(),
        kind: monitor.kind.clone(),
        group,
        target,
        status,
        message: message.to_string(),
        metrics,
    })
}

/// Newest archived telemetry sample for a monitor, if any.
async fn latest_sample(pool: &SqlitePool, monitor_id: i64) -> Option<Value> {
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM metrics_raw WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1",
    )
    .bind(monitor_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    serde_json::from_str(payload.as_deref()?).ok()
}

/// One-line usage summary from a telemetry sample: CPU, RAM, the fullest
/// disk and the 1-minute load. `None` when the sample carries none of them.
pub fn metrics_line(sample: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if let Some(cpu) = sample.pointer("/cpu/percent").and_then(Value::as_f64) {
        parts.push(format!("CPU {}", percent(cpu)));
    }
    if let Some(mem) = sample.pointer("/mem/percent").and_then(Value::as_f64) {
        parts.push(format!("RAM {}", percent(mem)));
    }
    if let Some(disks) = sample.get("disk").and_then(Value::as_array) {
        let fullest = disks
            .iter()
            .filter_map(|disk| {
                let percent = disk.get("percent").and_then(Value::as_f64)?;
                let mount = disk.get("mount").and_then(Value::as_str).unwrap_or("");
                Some((mount, percent))
            })
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((mount, used)) = fullest {
            let mount = if mount.is_empty() {
                String::new()
            } else {
                format!(" {mount}")
            };
            parts.push(format!("Disk{mount} {}", percent(used)));
        }
    }
    if let Some(load) = sample.pointer("/load/avg1").and_then(Value::as_f64) {
        parts.push(format!("Load {load:.2}"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

/// 7.5% and 75%: one decimal below ten, whole numbers above.
fn percent(value: f64) -> String {
    if value < 10.0 {
        format!("{value:.1}%")
    } else {
        format!("{value:.0}%")
    }
}

/// Send one Telegram message. Errors are returned for the caller to log; a
/// failed notification must never fail a heartbeat.
/// Delivery attempts per provider before giving up.
///
/// Telegram is a side channel: three attempts over a few seconds covers a
/// provider blip or a restart without holding an alert for minutes. Before
/// this, a single timeout logged and dropped the alert — with periodic
/// resend disabled the operator never heard about the outage at all.
const DELIVERY_ATTEMPTS: usize = 3;

/// Waits between attempts. A provider retry hint wins when it sends one.
const RETRY_BACKOFF: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(4),
];

/// Upper bound for a provider-supplied retry hint.
const MAX_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// One delivery attempt's classification.
pub(crate) enum Attempt {
    Delivered,
    /// Worth retrying: a network error, a timeout, a 5xx, or a rate limit.
    Retryable {
        reason: String,
        after: Option<std::time::Duration>,
    },
    /// Not worth retrying: the request itself is wrong (bad token, bad chat).
    Permanent(String),
}

/// Send one Telegram message, classifying the outcome.
async fn attempt_send_telegram(client: &reqwest::Client, config: &Telegram, text: &str) -> Attempt {
    let mut body = serde_json::json!({
        "chat_id": config.chat_id,
        "text": text,
        "disable_notification": config.disable_notification,
        "protect_content": config.protect_content,
        "link_preview_options": { "is_disabled": true },
    });
    if let Some(thread) = &config.message_thread_id {
        body["message_thread_id"] = thread.clone();
    }

    let url = format!("{}/bot{}/sendMessage", config.server_url, config.bot_token);
    let response = match client.post(url).json(&body).send().await {
        Ok(response) => response,
        Err(error) => {
            return Attempt::Retryable {
                reason: error.to_string(),
                after: None,
            };
        }
    };

    let status = response.status();
    if status.is_success() {
        return Attempt::Delivered;
    }
    let detail = response.text().await.unwrap_or_default();

    if status.as_u16() == 429 {
        // Telegram rate limiting: honour the hint it sends, bounded.
        let after = serde_json::from_str::<serde_json::Value>(&detail)
            .ok()
            .and_then(|body| {
                body.pointer("/parameters/retry_after")
                    .and_then(serde_json::Value::as_f64)
            })
            .map(|seconds| {
                std::time::Duration::from_secs_f64(
                    seconds.clamp(0.0, MAX_RETRY_AFTER.as_secs_f64()),
                )
            });
        return Attempt::Retryable {
            reason: format!("telegram answered {status}: {detail}"),
            after,
        };
    }
    if status.is_client_error() {
        return Attempt::Permanent(format!("telegram answered {status}: {detail}"));
    }
    Attempt::Retryable {
        reason: format!("telegram answered {status}: {detail}"),
        after: None,
    }
}

/// Deliver one Telegram message with bounded retries for transient failures.
pub async fn deliver_telegram(client: &reqwest::Client, name: &str, config: &Telegram, text: &str) {
    for attempt in 0..DELIVERY_ATTEMPTS {
        match attempt_send_telegram(client, config, text).await {
            Attempt::Delivered => return,
            Attempt::Permanent(reason) => {
                tracing::error!("notify: telegram send for {name} failed: {reason}");
                return;
            }
            Attempt::Retryable { reason, after } => {
                if attempt + 1 >= DELIVERY_ATTEMPTS {
                    tracing::error!(
                        "notify: telegram send for {name} failed after {DELIVERY_ATTEMPTS} attempts: {reason}"
                    );
                    return;
                }
                let wait = after.unwrap_or_else(|| {
                    RETRY_BACKOFF
                        .get(attempt)
                        .copied()
                        .unwrap_or(RETRY_BACKOFF[RETRY_BACKOFF.len() - 1])
                });
                tracing::warn!(
                    "notify: telegram send for {name} failed (attempt {}/{DELIVERY_ATTEMPTS}), retrying in {}ms: {reason}",
                    attempt + 1,
                    wait.as_millis()
                );
                tokio::time::sleep(wait).await;
            }
        }
    }
}

/// Send one Telegram message, without retries (tests and one-shot callers).
pub async fn send_telegram(
    client: &reqwest::Client,
    config: &Telegram,
    text: &str,
) -> anyhow::Result<()> {
    match attempt_send_telegram(client, config, text).await {
        Attempt::Delivered => Ok(()),
        Attempt::Permanent(reason) | Attempt::Retryable { reason, .. } => {
            anyhow::bail!("{reason}")
        }
    }
}

/// Active notification rows linked to a monitor: `(name, type, config)`.
pub async fn linked(
    pool: &SqlitePool,
    monitor_id: i64,
) -> sqlx::Result<Vec<(String, String, String)>> {
    sqlx::query_as(
        "SELECT n.name, n.type, n.config
         FROM notifications n
         JOIN monitor_notifications mn ON mn.notification_id = n.id
         WHERE mn.monitor_id = ? AND n.active = 1",
    )
    .bind(monitor_id)
    .fetch_all(pool)
    .await
}

/// Deliver one message to every active notification linked to a monitor.
/// Failures are logged per provider, never thrown: a broken notification
/// must never fail a heartbeat or an ingest.
///
/// When the server installed its [`Notifier`] (production), the message is
/// queued behind the same per-chat ordering and rate limit as heartbeat
/// alerts and this returns immediately; otherwise it is sent inline.
pub async fn dispatch_message(
    pool: &SqlitePool,
    client: &reqwest::Client,
    monitor_id: i64,
    message: String,
) {
    let global = GLOBAL.lock().unwrap().clone();
    let message = match global {
        Some(notifier) => match notifier.enqueue_message(monitor_id, message) {
            Ok(()) => return,
            Err(message) => message,
        },
        None => message,
    };

    let rows = match linked(pool, monitor_id).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!("notify: load links for monitor {monitor_id}: {error}");
            return;
        }
    };

    for (name, kind, config) in rows {
        if kind != "telegram" {
            continue;
        }
        let Some(telegram) = parse_telegram(&config) else {
            tracing::warn!("notify: {name} has no usable telegram config");
            continue;
        };
        deliver_telegram(client, &name, &telegram, &message).await;
    }
}

/// The notifier used by [`dispatch_message`] when one is installed.
static GLOBAL: Mutex<Option<Arc<Notifier>>> = Mutex::new(None);

/// Route [`dispatch_message`] through `notifier` (the server does this at
/// boot so metric alerts share the per-chat queues), or back to inline
/// delivery with `None`.
pub fn install_global(notifier: Option<Arc<Notifier>>) {
    *GLOBAL.lock().unwrap() = notifier;
}

/// Per-chat delivery limits.
///
/// Telegram allows about one message per second per chat and 20 per minute
/// in a group; the defaults stay under both: a burst of 3, then one message
/// every 3 s. Once `coalesce_at` alerts are waiting for a token they go out
/// as one summary.
#[derive(Debug, Clone)]
pub struct RateLimit {
    /// Bucket size: messages that may go out back to back.
    pub burst: f64,
    /// Sustained rate, in messages per second.
    pub per_second: f64,
    /// Backlog length at which pending alerts are merged into one summary.
    pub coalesce_at: usize,
    /// Queue bound per chat; beyond it the oldest alerts are dropped (and
    /// counted in the next summary).
    pub capacity: usize,
    /// A chat worker with nothing to do exits after this long.
    pub idle_exit: Duration,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            burst: 3.0,
            per_second: 1.0 / 3.0,
            coalesce_at: 4,
            capacity: 200,
            idle_exit: Duration::from_secs(300),
        }
    }
}

/// How many 429s with a retry hint one message may absorb before it is
/// dropped; the queue behind it coalesces meanwhile.
const MAX_RATE_LIMITED: usize = 5;

/// Pending jobs the dispatcher may hold before new alerts are dropped.
const JOB_CAPACITY: usize = 10_000;

/// Telegram rejects messages above 4096 characters; summaries stay below.
const SUMMARY_MAX_CHARS: usize = 3800;

type SendFuture<'a> = Pin<Box<dyn Future<Output = Attempt> + Send + 'a>>;

/// The provider call, behind a trait so tests can fake it.
pub(crate) trait Transport: Send + Sync + 'static {
    fn send<'a>(&'a self, config: &'a Telegram, text: &'a str) -> SendFuture<'a>;
}

struct HttpTransport(reqwest::Client);

impl Transport for HttpTransport {
    fn send<'a>(&'a self, config: &'a Telegram, text: &'a str) -> SendFuture<'a> {
        Box::pin(attempt_send_telegram(&self.0, config, text))
    }
}

/// A token bucket: `burst` tokens, refilled at `per_second`.
struct TokenBucket {
    tokens: f64,
    burst: f64,
    per_second: f64,
    refilled: Instant,
}

impl TokenBucket {
    fn new(limits: &RateLimit) -> Self {
        Self {
            tokens: limits.burst.max(1.0),
            burst: limits.burst.max(1.0),
            per_second: limits.per_second.max(f64::MIN_POSITIVE),
            refilled: Instant::now(),
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.refilled).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.per_second).min(self.burst);
        self.refilled = now;
    }

    /// How long until a token is available (zero when one is).
    fn wait_time(&mut self) -> Duration {
        self.refill();
        if self.tokens >= 1.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64((1.0 - self.tokens) / self.per_second)
        }
    }

    fn take(&mut self) {
        self.refill();
        self.tokens = (self.tokens - 1.0).max(0.0);
    }

    /// The provider said slow down: start refilling from empty.
    fn drain(&mut self) {
        self.tokens = 0.0;
        self.refilled = Instant::now();
    }
}

/// Destination identity: one queue (and one ordering) per bot and chat.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ChatKey {
    server_url: String,
    bot_token: String,
    chat_id: String,
    thread: String,
}

impl ChatKey {
    fn of(config: &Telegram) -> Self {
        Self {
            server_url: config.server_url.clone(),
            bot_token: config.bot_token.clone(),
            chat_id: config.chat_id.clone(),
            thread: config
                .message_thread_id
                .as_ref()
                .map(Value::to_string)
                .unwrap_or_default(),
        }
    }
}

struct ChatQueue {
    config: Telegram,
    /// Notification row name, for logs.
    name: String,
    items: VecDeque<String>,
    /// Alerts dropped at the queue bound since the last send.
    dropped: usize,
    worker: bool,
    wake: Arc<Notify>,
}

enum Job {
    Heartbeat {
        monitor: Box<Monitor>,
        status: i64,
        msg: String,
    },
    Message {
        monitor_id: i64,
        text: String,
    },
}

/// Ordered, rate-limited alert delivery (E3).
///
/// * `enqueue_*` never blocks: a job goes on a bounded channel.
/// * One dispatcher resolves jobs strictly in order (message text, linked
///   notification rows) and appends them to per-chat queues.
/// * One worker per chat sends in queue order behind a [`TokenBucket`];
///   a DOWN can no longer overtake the UP that followed it.
/// * When `coalesce_at` alerts are waiting, the worker sends one summary
///   listing them in order instead of N separate messages.
/// * [`Notifier::shutdown`] drains everything with a deadline.
pub struct Notifier {
    pool: SqlitePool,
    transport: Arc<dyn Transport>,
    limits: RateLimit,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    receiver: Mutex<Option<mpsc::Receiver<Job>>>,
    dispatcher: Mutex<Option<JoinHandle<()>>>,
    chats: Mutex<HashMap<ChatKey, ChatQueue>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    closing: AtomicBool,
}

impl Notifier {
    pub fn new(pool: SqlitePool, client: reqwest::Client) -> Arc<Self> {
        Self::with_transport(pool, Arc::new(HttpTransport(client)), RateLimit::default())
    }

    pub(crate) fn with_transport(
        pool: SqlitePool,
        transport: Arc<dyn Transport>,
        limits: RateLimit,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(JOB_CAPACITY);
        Arc::new(Self {
            pool,
            transport,
            limits,
            jobs: Mutex::new(Some(tx)),
            receiver: Mutex::new(Some(rx)),
            dispatcher: Mutex::new(None),
            chats: Mutex::new(HashMap::new()),
            workers: Mutex::new(Vec::new()),
            closing: AtomicBool::new(false),
        })
    }

    /// Queue the alert for a heartbeat transition. Non-blocking; the
    /// message (group path, last telemetry) is built by the dispatcher.
    pub fn enqueue_heartbeat(self: &Arc<Self>, monitor: &Monitor, status: i64, msg: &str) {
        let job = Job::Heartbeat {
            monitor: Box::new(monitor.clone()),
            status,
            msg: msg.to_string(),
        };
        if self.submit(job).is_err() {
            tracing::error!(
                "notify: alert for {} dropped: the notifier is closed or full",
                monitor.name
            );
        }
    }

    /// Queue a prebuilt message for every chat linked to a monitor. Hands
    /// the message back when the notifier cannot take it.
    pub fn enqueue_message(self: &Arc<Self>, monitor_id: i64, text: String) -> Result<(), String> {
        match self.submit(Job::Message { monitor_id, text }) {
            Ok(()) => Ok(()),
            Err(Job::Message { text, .. }) => Err(text),
            Err(_) => unreachable!("submit returns the job it was given"),
        }
    }

    fn submit(self: &Arc<Self>, job: Job) -> Result<(), Job> {
        let sender = self.jobs.lock().unwrap().clone();
        let Some(sender) = sender else {
            return Err(job);
        };
        self.ensure_dispatcher();
        sender.try_send(job).map_err(|error| match error {
            mpsc::error::TrySendError::Full(job) | mpsc::error::TrySendError::Closed(job) => job,
        })
    }

    /// Spawn the dispatcher on first use (construction may happen outside
    /// a runtime).
    fn ensure_dispatcher(self: &Arc<Self>) {
        let Some(mut receiver) = self.receiver.lock().unwrap().take() else {
            return;
        };
        let notifier = Arc::clone(self);
        let handle = tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                notifier.resolve(job).await;
            }
        });
        *self.dispatcher.lock().unwrap() = Some(handle);
    }

    /// Turn one job into per-chat queue entries, in order.
    async fn resolve(self: &Arc<Self>, job: Job) {
        let (monitor_id, text) = match job {
            Job::Heartbeat {
                monitor,
                status,
                msg,
            } => {
                let text = build_heartbeat_message(&self.pool, &monitor, status, &msg).await;
                (monitor.id, text)
            }
            Job::Message { monitor_id, text } => (monitor_id, text),
        };

        let rows = match linked(&self.pool, monitor_id).await {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!("notify: load links for monitor {monitor_id}: {error}");
                return;
            }
        };
        for (name, kind, config) in rows {
            if kind != "telegram" {
                continue;
            }
            let Some(telegram) = parse_telegram(&config) else {
                tracing::warn!("notify: {name} has no usable telegram config");
                continue;
            };
            self.enqueue_chat(&name, telegram, text.clone());
        }
    }

    /// Append one message to a chat's queue and make sure its worker runs.
    pub(crate) fn enqueue_chat(self: &Arc<Self>, name: &str, config: Telegram, text: String) {
        let key = ChatKey::of(&config);
        let mut chats = self.chats.lock().unwrap();
        let queue = chats.entry(key.clone()).or_insert_with(|| ChatQueue {
            config: config.clone(),
            name: name.to_string(),
            items: VecDeque::new(),
            dropped: 0,
            worker: false,
            wake: Arc::new(Notify::new()),
        });
        queue.config = config;
        queue.items.push_back(text);
        while queue.items.len() > self.limits.capacity.max(1) {
            queue.items.pop_front();
            queue.dropped += 1;
        }
        queue.wake.notify_one();

        if !queue.worker {
            queue.worker = true;
            let notifier = Arc::clone(self);
            let handle = tokio::spawn(async move { notifier.chat_worker(key).await });
            let mut workers = self.workers.lock().unwrap();
            workers.retain(|worker| !worker.is_finished());
            workers.push(handle);
        }
    }

    /// Drain one chat's queue in order, behind its token bucket.
    async fn chat_worker(self: Arc<Self>, key: ChatKey) {
        let mut bucket = TokenBucket::new(&self.limits);
        loop {
            // Wait for work; exit when idle (or closing and empty).
            let wake = {
                let mut chats = self.chats.lock().unwrap();
                let Some(queue) = chats.get_mut(&key) else {
                    return;
                };
                if queue.items.is_empty() {
                    if self.closing.load(Ordering::SeqCst) {
                        queue.worker = false;
                        return;
                    }
                    Some(Arc::clone(&queue.wake))
                } else {
                    None
                }
            };
            if let Some(wake) = wake {
                let woke = tokio::time::timeout(self.limits.idle_exit, wake.notified()).await;
                if woke.is_err() {
                    let mut chats = self.chats.lock().unwrap();
                    if let Some(queue) = chats.get_mut(&key)
                        && queue.items.is_empty()
                    {
                        chats.remove(&key);
                        return;
                    }
                }
                continue;
            }

            // Wait for a token; the backlog may keep growing meanwhile.
            loop {
                let wait = bucket.wait_time();
                if wait.is_zero() {
                    break;
                }
                tokio::time::sleep(wait).await;
            }

            // Take one message, or the whole backlog as a summary.
            let (name, config, text) = {
                let mut chats = self.chats.lock().unwrap();
                let Some(queue) = chats.get_mut(&key) else {
                    return;
                };
                let closing = self.closing.load(Ordering::SeqCst);
                let coalesce = queue.dropped > 0
                    || queue.items.len() >= self.limits.coalesce_at.max(2)
                    || (closing && queue.items.len() > 1);
                let text = if coalesce {
                    let items: Vec<String> = queue.items.drain(..).collect();
                    let dropped = std::mem::take(&mut queue.dropped);
                    summary(&items, dropped)
                } else {
                    match queue.items.pop_front() {
                        Some(text) => text,
                        None => continue,
                    }
                };
                (queue.name.clone(), queue.config.clone(), text)
            };

            bucket.take();
            self.deliver(&mut bucket, &name, &config, &text).await;
        }
    }

    /// Send one message with bounded retries; a 429 drains the bucket and
    /// waits out the provider's hint.
    async fn deliver(&self, bucket: &mut TokenBucket, name: &str, config: &Telegram, text: &str) {
        let mut failures = 0;
        let mut limited = 0;
        loop {
            match self.transport.send(config, text).await {
                Attempt::Delivered => return,
                Attempt::Permanent(reason) => {
                    tracing::error!("notify: telegram send for {name} failed: {reason}");
                    return;
                }
                Attempt::Retryable {
                    reason,
                    after: Some(after),
                } if limited < MAX_RATE_LIMITED => {
                    limited += 1;
                    bucket.drain();
                    tracing::warn!(
                        "notify: telegram rate-limited {name}, retrying in {}ms: {reason}",
                        after.as_millis()
                    );
                    tokio::time::sleep(after).await;
                }
                Attempt::Retryable { reason, after } => {
                    failures += 1;
                    if failures >= DELIVERY_ATTEMPTS {
                        tracing::error!(
                            "notify: telegram send for {name} failed after {failures} attempts: {reason}"
                        );
                        return;
                    }
                    let wait = after.unwrap_or_else(|| {
                        RETRY_BACKOFF
                            .get(failures - 1)
                            .copied()
                            .unwrap_or(RETRY_BACKOFF[RETRY_BACKOFF.len() - 1])
                    });
                    tracing::warn!(
                        "notify: telegram send for {name} failed (attempt {failures}/{DELIVERY_ATTEMPTS}), retrying in {}ms: {reason}",
                        wait.as_millis()
                    );
                    tokio::time::sleep(wait).await;
                }
            }
        }
    }

    /// Alerts accepted but not yet handed to the provider.
    pub fn pending(&self) -> usize {
        self.chats
            .lock()
            .unwrap()
            .values()
            .map(|queue| queue.items.len())
            .sum()
    }

    /// Stop accepting alerts and deliver what is queued, until `deadline`.
    /// Whatever is still pending then is dropped and logged.
    pub async fn shutdown(&self, deadline: Instant) {
        self.closing.store(true, Ordering::SeqCst);
        // Closing the channel lets the dispatcher finish the backlog and end.
        self.jobs.lock().unwrap().take();
        let dispatcher = self.dispatcher.lock().unwrap().take();
        if let Some(mut dispatcher) = dispatcher
            && tokio::time::timeout_at(deadline, &mut dispatcher)
                .await
                .is_err()
        {
            dispatcher.abort();
        }

        for queue in self.chats.lock().unwrap().values() {
            queue.wake.notify_one();
        }
        let workers: Vec<JoinHandle<()>> = std::mem::take(&mut *self.workers.lock().unwrap());
        let mut timed_out = false;
        for mut worker in workers {
            if timed_out
                || tokio::time::timeout_at(deadline, &mut worker)
                    .await
                    .is_err()
            {
                timed_out = true;
                worker.abort();
            }
        }

        let lost = self.pending();
        if lost > 0 {
            tracing::error!("notify: shutdown deadline passed with {lost} alerts undelivered");
        }
    }
}

/// One message for a coalesced backlog: the headline of every alert, in
/// order, bounded below Telegram's size limit.
fn summary(items: &[String], dropped: usize) -> String {
    let mut header = format!("[⚠️ {} alerts]", items.len() + dropped);
    if dropped > 0 {
        header.push_str(&format!(" [{dropped} oldest dropped: queue full]"));
    }
    let mut lines = vec![header];
    let mut length = lines[0].len();
    for (index, item) in items.iter().enumerate() {
        let headline = item.lines().next().unwrap_or_default();
        let detail = item.lines().nth(2).unwrap_or_default();
        let line = if detail.is_empty() {
            headline.to_string()
        } else {
            format!("{headline} {detail}")
        };
        if length + line.len() + 1 > SUMMARY_MAX_CHARS {
            lines.push(format!("[… and {} more]", items.len() - index));
            break;
        }
        length += line.len() + 1;
        lines.push(line);
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn parses_the_office_config_shape() {
        let config = r#"{
            "name": "MBG Alerts",
            "type": "telegram",
            "telegramServerUrl": "https://api.telegram.org",
            "telegramChatID": "-1003740273903",
            "telegramBotToken": "123:abc",
            "telegramUseTemplate": false
        }"#;

        let parsed = parse_telegram(config).expect("config must parse");
        assert_eq!(parsed.chat_id, "-1003740273903");
        assert_eq!(parsed.bot_token, "123:abc");
        assert!(!parsed.disable_notification);
        assert!(!parsed.protect_content);
        assert!(parsed.message_thread_id.is_none());
    }

    #[tokio::test]
    async fn deliver_telegram_retries_transient_failures_and_stops_on_permanent() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        // A stub bot API: the first `failures` answers are 500, then success.
        async fn stub(failures: usize) -> (String, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let state = Arc::clone(&calls);
            let app = axum::Router::new().route(
                "/bot{token}/sendMessage",
                axum::routing::post(move || {
                    let state = Arc::clone(&state);
                    async move {
                        let call = state.fetch_add(1, Ordering::SeqCst);
                        if call < failures {
                            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "boom")
                        } else {
                            (axum::http::StatusCode::OK, "{\"ok\":true}")
                        }
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            (format!("http://{addr}"), calls)
        }

        let config = |base: &str| {
            parse_telegram(&format!(
            r#"{{"telegramServerUrl": "{base}", "telegramBotToken": "t", "telegramChatID": "1"}}"#
        ))
        .unwrap()
        };

        // Two transient failures, then delivered on the third attempt.
        let (base, calls) = stub(2).await;
        deliver_telegram(&reqwest::Client::new(), "stub", &config(&base), "hi").await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "transient failures are retried"
        );

        // A 4xx is permanent: no retry.
        let calls = Arc::new(AtomicUsize::new(0));
        let state = Arc::clone(&calls);
        let app = axum::Router::new().route(
            "/bot{token}/sendMessage",
            axum::routing::post(move || {
                let state = Arc::clone(&state);
                async move {
                    state.fetch_add(1, Ordering::SeqCst);
                    (axum::http::StatusCode::BAD_REQUEST, "bad chat")
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        deliver_telegram(
            &reqwest::Client::new(),
            "stub",
            &config(&format!("http://{addr}")),
            "hi",
        )
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "a 4xx is not retried");
    }

    #[test]
    fn refuses_configs_without_credentials() {
        assert!(parse_telegram("{}").is_none());
        assert!(parse_telegram(r#"{"telegramBotToken": ""}"#).is_none());
        assert!(parse_telegram("not json").is_none());
    }

    #[test]
    fn alert_shape_is_one_bracketed_field_per_line() {
        let http = format_alert(&AlertParts {
            name: "national-business".into(),
            kind: "http".into(),
            group: Some("work / nationalbusiness.kz".into()),
            target: Some("https://nationalbusiness.kz".into()),
            status: 0,
            message: "500 - Internal Server Error".into(),
            metrics: None,
        });
        assert_eq!(
            http,
            "[🔴 DOWN] [work / nationalbusiness.kz] [national-business]\n\
             [http] [https://nationalbusiness.kz]\n\
             [500 - Internal Server Error]"
        );

        let up = format_alert(&AlertParts {
            name: "cmn".into(),
            kind: "push".into(),
            group: None,
            target: Some("cmn".into()),
            status: 1,
            message: "OK".into(),
            metrics: None,
        });
        assert_eq!(up, "[✅ UP] [Ungrouped] [cmn]\n[push] [cmn]\n[OK]");
    }

    #[test]
    fn push_alerts_carry_the_last_metrics_line() {
        let message = format_alert(&AlertParts {
            name: "modernization-meks".into(),
            kind: "push".into(),
            group: Some("work / MEKS".into()),
            target: Some("modernization-meks".into()),
            status: 0,
            message: "No heartbeat in the time window".into(),
            metrics: Some("CPU 12% · RAM 43% · Disk / 71% · Load 0.42".into()),
        });
        assert_eq!(
            message,
            "[🔴 DOWN] [work / MEKS] [modernization-meks]\n\
             [push] [modernization-meks]\n\
             [No heartbeat in the time window]\n\
             [CPU 12% · RAM 43% · Disk / 71% · Load 0.42]"
        );
    }

    #[test]
    fn metrics_line_uses_the_fullest_disk_and_hides_missing_parts() {
        let sample = serde_json::json!({
            "cpu": { "percent": 7.56 },
            "mem": { "percent": 43.2 },
            "disk": [
                { "mount": "/", "percent": 71.4 },
                { "mount": "/data", "percent": 12.0 },
            ],
            "load": { "avg1": 0.421 },
        });
        assert_eq!(
            metrics_line(&sample).unwrap(),
            "CPU 7.6% · RAM 43% · Disk / 71% · Load 0.42"
        );

        assert!(metrics_line(&serde_json::json!({})).is_none());
    }

    #[test]
    fn messages_stay_single_line() {
        let message = format_alert(&AlertParts {
            name: "cmn".into(),
            kind: "push".into(),
            group: None,
            target: None,
            status: 2,
            message: "first\nsecond".into(),
            metrics: None,
        });
        assert_eq!(
            message,
            "[⏳ PENDING] [Ungrouped] [cmn]\n[push]\n[first second]"
        );
    }

    /// A fake provider: records every send with its time; answers from a
    /// script (`None` = delivered) and then delivers.
    struct FakeTransport {
        sent: Mutex<Vec<(Instant, String)>>,
        script: Mutex<VecDeque<Option<Duration>>>,
    }

    impl FakeTransport {
        fn new(script: Vec<Option<Duration>>) -> Arc<Self> {
            Arc::new(Self {
                sent: Mutex::new(Vec::new()),
                script: Mutex::new(script.into()),
            })
        }

        fn texts(&self) -> Vec<String> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .map(|(_, text)| text.clone())
                .collect()
        }
    }

    impl Transport for FakeTransport {
        fn send<'a>(&'a self, _config: &'a Telegram, text: &'a str) -> SendFuture<'a> {
            Box::pin(async move {
                self.sent
                    .lock()
                    .unwrap()
                    .push((Instant::now(), text.to_string()));
                match self.script.lock().unwrap().pop_front().flatten() {
                    // Scripted 429 with a retry hint.
                    Some(after) => Attempt::Retryable {
                        reason: "429".into(),
                        after: Some(after),
                    },
                    None => Attempt::Delivered,
                }
            })
        }
    }

    async fn scratch_pool() -> SqlitePool {
        let dir = tempfile::tempdir().unwrap();
        crate::db::connect(&dir.keep()).await.unwrap()
    }

    fn chat(id: &str) -> Telegram {
        parse_telegram(&format!(
            r#"{{"telegramBotToken": "t", "telegramChatID": "{id}"}}"#
        ))
        .unwrap()
    }

    async fn wait_for_sends(fake: &FakeTransport, count: usize) {
        for _ in 0..200 {
            if fake.sent.lock().unwrap().len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected {count} sends, got {:?}", fake.texts());
    }

    #[tokio::test]
    async fn chat_queue_keeps_order_and_honours_the_token_bucket() {
        let fake = FakeTransport::new(vec![]);
        let limits = RateLimit {
            burst: 2.0,
            per_second: 20.0, // one token per 50 ms
            coalesce_at: 100,
            ..RateLimit::default()
        };
        let notifier = Notifier::with_transport(scratch_pool().await, fake.clone(), limits);

        let started = Instant::now();
        for index in 0..6 {
            notifier.enqueue_chat("alerts", chat("1"), format!("m{index}"));
        }
        wait_for_sends(&fake, 6).await;

        assert_eq!(
            fake.texts(),
            ["m0", "m1", "m2", "m3", "m4", "m5"],
            "FIFO per chat"
        );
        let times: Vec<Duration> = fake
            .sent
            .lock()
            .unwrap()
            .iter()
            .map(|(at, _)| at.duration_since(started))
            .collect();
        // The burst goes out at once; after it, one send per refill.
        assert!(times[1] < Duration::from_millis(40), "burst: {times:?}");
        for pair in times[2..].windows(2) {
            assert!(
                pair[1] - pair[0] >= Duration::from_millis(40),
                "spacing: {times:?}"
            );
        }
        assert!(times[5] >= Duration::from_millis(180), "rate: {times:?}");
    }

    #[tokio::test]
    async fn backlog_coalesces_into_an_ordered_summary() {
        let fake = FakeTransport::new(vec![]);
        let limits = RateLimit {
            burst: 1.0,
            per_second: 10.0,
            coalesce_at: 3,
            ..RateLimit::default()
        };
        let notifier = Notifier::with_transport(scratch_pool().await, fake.clone(), limits);

        // Another chat is independent of this one's backlog.
        notifier.enqueue_chat("other", chat("2"), "solo".into());
        for index in 0..10 {
            notifier.enqueue_chat(
                "alerts",
                chat("1"),
                format!("[🔴 DOWN] [g] [m{index}]\n[http]\n[boom {index}]"),
            );
        }
        wait_for_sends(&fake, 2).await;
        tokio::time::sleep(Duration::from_millis(250)).await;

        let texts = fake.texts();
        assert!(texts.contains(&"solo".to_string()));
        let summaries: Vec<&String> = texts.iter().filter(|text| text.contains("[m")).collect();
        assert!(summaries.len() < 10, "the burst coalesced: {texts:?}");
        let joined = summaries
            .iter()
            .map(|text| text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            joined.starts_with("[⚠️ 10 alerts]"),
            "summary header: {joined}"
        );
        let mut last = 0;
        for index in 0..10 {
            let at = joined
                .find(&format!("[m{index}] [boom {index}]"))
                .unwrap_or_else(|| panic!("m{index} missing from {joined}"));
            assert!(at >= last, "summary keeps transition order");
            last = at;
        }
    }

    #[tokio::test]
    async fn rate_limited_send_is_retried_before_the_next_message() {
        // One 429 with a 60 ms hint: the same message is retried, and the
        // message behind it does not overtake it.
        let fake = FakeTransport::new(vec![Some(Duration::from_millis(60))]);
        let limits = RateLimit {
            burst: 5.0,
            per_second: 100.0,
            coalesce_at: 100,
            ..RateLimit::default()
        };
        let notifier = Notifier::with_transport(scratch_pool().await, fake.clone(), limits);
        notifier.enqueue_chat("alerts", chat("1"), "down".into());
        notifier.enqueue_chat("alerts", chat("1"), "up".into());
        wait_for_sends(&fake, 3).await;
        assert_eq!(fake.texts(), ["down", "down", "up"]);
        let sent = fake.sent.lock().unwrap();
        assert!(
            sent[1].0 - sent[0].0 >= Duration::from_millis(55),
            "hint honoured"
        );
    }

    #[tokio::test]
    async fn shutdown_delivers_the_backlog_within_the_deadline() {
        let fake = FakeTransport::new(vec![]);
        let limits = RateLimit {
            burst: 1.0,
            per_second: 2.0,
            coalesce_at: 100,
            ..RateLimit::default()
        };
        let notifier = Notifier::with_transport(scratch_pool().await, fake.clone(), limits);
        for index in 0..5 {
            notifier.enqueue_chat("alerts", chat("1"), format!("[x] [m{index}]"));
        }
        let started = Instant::now();
        notifier
            .shutdown(Instant::now() + Duration::from_secs(3))
            .await;
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "closing coalesces instead of pacing"
        );
        assert_eq!(notifier.pending(), 0, "nothing left behind");
        let joined = fake.texts().join("\n");
        for index in 0..5 {
            assert!(
                joined.contains(&format!("[m{index}]")),
                "m{index} delivered: {joined}"
            );
        }
        // A closed notifier refuses new work instead of losing it silently.
        assert!(notifier.enqueue_message(1, "late".into()).is_err());
    }

    #[tokio::test]
    async fn heartbeat_alerts_resolve_in_transition_order() {
        let pool = scratch_pool().await;
        let fake = FakeTransport::new(vec![]);
        let notifier = Notifier::with_transport(pool.clone(), fake.clone(), RateLimit::default());

        let monitor = sqlx::query_as::<_, Monitor>(
            "INSERT INTO monitors (name, type) VALUES ('api', 'http') RETURNING *",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let (notification,): (i64,) = sqlx::query_as(
            "INSERT INTO notifications (name, type, config) VALUES ('alerts', 'telegram', ?) RETURNING id",
        )
        .bind(r#"{"telegramBotToken": "t", "telegramChatID": "1"}"#)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO monitor_notifications (monitor_id, notification_id) VALUES (?, ?)",
        )
        .bind(monitor.id)
        .bind(notification)
        .execute(&pool)
        .await
        .unwrap();

        notifier.enqueue_heartbeat(&monitor, crate::heartbeats::DOWN, "boom");
        notifier.enqueue_heartbeat(&monitor, UP, "200 - OK");
        wait_for_sends(&fake, 2).await;
        let texts = fake.texts();
        assert!(texts[0].starts_with("[🔴 DOWN]"), "{texts:?}");
        assert!(texts[1].starts_with("[✅ UP]"), "{texts:?}");
    }
}
