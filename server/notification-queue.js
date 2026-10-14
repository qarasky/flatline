const { log } = require("../src/util");

/**
 * Bounded asynchronous notification delivery.
 *
 * Notification delivery is a side effect of a monitor transition: it must
 * never hold the beat, the push request or an alert evaluation open. A
 * Telegram endpoint (or its proxy) that accepts the connection without
 * answering used to freeze whichever path awaited it — Axios ships with no
 * timeout — so the heartbeat stayed unstored and the monitor loop parked at
 * the transition.
 *
 * Deliveries are queued and dispatched in order by a single worker, so an
 * outage cannot reorder down/up transitions. The queue is bounded: an
 * unreachable provider can back it up, but it can never exhaust memory, and
 * anything dropped is logged and counted instead of disappearing silently.
 * Each delivery is also bounded by the provider's own request deadline.
 *
 * Transient failures (network errors, timeouts, 5xx, provider rate limits)
 * are retried a bounded number of times with backoff, honouring a
 * `retry_after` hint when the provider sends one; permanent failures (a bad
 * token, a wrong chat id) are not retried. Before this, a single timeout
 * silently lost the alert — with periodic resend disabled, the operator
 * never heard about the outage at all.
 */

/** Maximum queued deliveries before new ones are dropped. */
const MAX_QUEUE = 100;

/** Delivery attempts per notification before giving up. */
const MAX_ATTEMPTS = 3;

/** Waits between attempts (ms); a provider retry hint wins when present. */
const RETRY_BACKOFF_MS = [ 1000, 4000 ];

/** Upper bound for a provider-supplied retry hint. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Queued deliveries, oldest first, with their enqueue time. */
const queue = [];

/** Cumulative counters, for the log line and for tests. */
const counters = {
    delivered: 0,
    failed: 0,
    dropped: 0,
    retries: 0,
};

let running = false;

/**
 * Queue one notification delivery.
 *
 * Returns immediately; the worker runs deliveries one at a time. When the
 * queue is full the delivery is dropped and logged — a notification is
 * never worth unbounded memory.
 * @param {string} label Human-readable target, for logs
 * @param {() => Promise<void>} deliver Performs the delivery
 * @returns {boolean} True when queued, false when dropped
 */
function enqueueNotification(label, deliver) {
    if (queue.length >= MAX_QUEUE) {
        counters.dropped++;
        log.error("notification", `Notification queue is full (${MAX_QUEUE}); dropping ${label}`);
        return false;
    }
    queue.push({ label, deliver, enqueuedAt: Date.now() });
    void drain();
    return true;
}

/**
 * Classify a failed delivery: retry it or not, and how long to wait.
 *
 * Provider hints win over the fixed backoff: Telegram answers 429 with
 * `parameters.retry_after` (seconds) when it is rate limiting us. Any other
 * 4xx is the request's fault — a bad token, an unknown chat — and repeating
 * it would just burn attempts.
 * @param {*} error Error thrown by the delivery
 * @returns {{retryable: boolean, afterMs: ?number}} Classification
 */
function classifyDeliveryFailure(error) {
    const status = error?.response?.status ?? error?.status;
    if (status === 429) {
        const retryAfterSeconds = Number(error?.response?.data?.parameters?.retry_after);
        return {
            retryable: true,
            afterMs: Number.isFinite(retryAfterSeconds)
                ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
                : null,
        };
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
        return { retryable: false, afterMs: null };
    }
    return { retryable: true, afterMs: null };
}

/**
 * Deliver one queued notification, retrying transient failures in place.
 *
 * In place on purpose: retrying through the queue would reorder a monitor's
 * transitions behind later ones.
 * @param {{label: string, deliver: () => Promise<void>}} item Queued delivery
 * @returns {Promise<void>} Resolves when delivered or abandoned
 */
async function deliverWithRetries(item) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            await item.deliver();
            counters.delivered++;
            return;
        } catch (e) {
            const { retryable, afterMs } = classifyDeliveryFailure(e);
            if (!retryable || attempt + 1 >= MAX_ATTEMPTS) {
                counters.failed++;
                log.error(
                    "notification",
                    `Cannot deliver notification to ${item.label} after ${attempt + 1} attempt(s): ${e.message}`
                );
                return;
            }

            counters.retries++;
            const wait = afterMs ?? RETRY_BACKOFF_MS[attempt];
            log.warn(
                "notification",
                `Delivery to ${item.label} failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${wait}ms: ${e.message}`
            );
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
}

/**
 * Deliver queued notifications in order until the queue is empty.
 * @returns {Promise<void>} Resolves when the queue has drained
 */
async function drain() {
    if (running) {
        return;
    }
    running = true;
    try {
        while (queue.length > 0) {
            const item = queue.shift();
            await deliverWithRetries(item);
        }
    } finally {
        running = false;
    }
}

/**
 * Wait (bounded) until every queued delivery has settled. Used by shutdown
 * and by tests that assert on delivered messages.
 * @param {number} timeoutMs How long to wait at most
 * @returns {Promise<boolean>} True when the queue drained in time
 */
async function flushNotifications(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while ((running || queue.length > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !running && queue.length === 0;
}

/**
 * Queue length, for tests and diagnostics.
 * @returns {number} Pending deliveries
 */
function pendingNotifications() {
    return queue.length;
}

/**
 * Cumulative delivery counters.
 * @returns {{delivered: number, failed: number, dropped: number, retries: number}} Counters
 */
function notificationCounters() {
    return { ...counters };
}

/**
 * Queue health for diagnostics and the health endpoint: depth, age of the
 * oldest waiting delivery, and the cumulative counters. The age is what
 * tells an operator that a provider has been failing for a while.
 * @returns {{pending: number, oldestAgeMs: ?number, delivered: number, failed: number, retries: number, dropped: number}} Queue stats
 */
function notificationQueueStats() {
    const oldest = queue[0];
    return {
        pending: queue.length,
        oldestAgeMs: oldest ? Date.now() - oldest.enqueuedAt : null,
        ...counters,
    };
}

module.exports = {
    enqueueNotification,
    flushNotifications,
    pendingNotifications,
    notificationCounters,
    notificationQueueStats,
    classifyDeliveryFailure,
    MAX_QUEUE,
    MAX_ATTEMPTS,
};
