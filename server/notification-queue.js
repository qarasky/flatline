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
 */

/** Maximum queued deliveries before new ones are dropped. */
const MAX_QUEUE = 100;

/** Queued deliveries, oldest first. */
const queue = [];

/** Cumulative counters, for the log line and for tests. */
const counters = {
    delivered: 0,
    failed: 0,
    dropped: 0,
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
    queue.push({ label, deliver });
    void drain();
    return true;
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
            try {
                await item.deliver();
                counters.delivered++;
            } catch (e) {
                counters.failed++;
                log.error("notification", `Cannot deliver notification to ${item.label}: ${e.message}`);
            }
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
 * @returns {{delivered: number, failed: number, dropped: number}} Counters
 */
function notificationCounters() {
    return { ...counters };
}

module.exports = {
    enqueueNotification,
    flushNotifications,
    pendingNotifications,
    notificationCounters,
    MAX_QUEUE,
};
