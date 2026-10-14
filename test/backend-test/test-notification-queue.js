/**
 * Notification delivery must never hold the beat path open.
 *
 * The audit reproduced a Telegram endpoint (or proxy) that accepts the
 * connection and never answers: delivery remained unresolved, so the monitor
 * transition path awaited it forever and the heartbeat was never stored.
 * Delivery is now queued and bounded, and every request has an explicit
 * deadline.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

// @ts-ignore
const TestDB = require("../mock-testdb");

const testDb = new TestDB("./data/test-notification-queue");

test("notification delivery never blocks the beat path", async (t) => {
    const { R } = require("redbean-node");
    const Monitor = require("../../server/model/monitor");
    const { flushNotifications, pendingNotifications, notificationCounters } = require("../../server/notification-queue");
    const requests = [];
    let telegram = null;
    let monitor = null;
    // The fixture withholds the reply until the test releases it, so the
    // "delivery must not be awaited" assertion is about the gate itself and
    // not about a wall-clock bound that a loaded suite can trip.
    let releaseReply = null;
    let replyGate = null;

    t.before(async () => {
        await testDb.create();
        const { auth } = require("../../server/better-auth");
        await auth();
        await auth().api.createUser({
            body: {
                name: "admin", email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p", role: "admin", data: { username: "admin" },
            },
        });
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);

        // The audit's fixture: accepts the request and withholds the reply.
        // The test releases it explicitly once it has proven that nothing on
        // the beat path waited for delivery.
        replyGate = new Promise((resolve) => {
            releaseReply = resolve;
        });
        const app = express();
        app.use(express.json());
        app.post("/*", async (req, res) => {
            requests.push(req.body);
            await replyGate;
            res.json({ ok: true, result: { message_id: requests.length } });
        });
        telegram = await new Promise((resolve) => {
            const server = app.listen(0, "127.0.0.1", () => resolve(server));
        });

        monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Hung Notification Host";
        monitor.type = "push";
        monitor.interval = 60;
        monitor.retryInterval = 60;
        monitor.timeout = 48;
        monitor.active = 1;
        monitor.accepted_statuscodes_json = JSON.stringify([ "200-299" ]);
        // Every column monitor.toJSON() parses; a real monitor row gets these
        // from monitor-service defaults.
        monitor.kafkaProducerBrokers = "[]";
        monitor.rabbitmqNodes = "[]";
        monitor.conditions = "[]";
        monitor.kafkaProducerSaslOptions = "{}";
        await R.store(monitor);

        const notification = R.dispense("notification");
        notification.name = "HangingTelegram";
        notification.active = 1;
        notification.user_id = owner.id;
        notification.is_default = 0;
        notification.config = JSON.stringify({
            type: "telegram",
            telegramBotToken: "test-token",
            telegramChatID: "12345",
            telegramServerUrl: `http://127.0.0.1:${telegram.address().port}`,
        });
        await R.store(notification);

        const link = R.dispense("monitor_notification");
        link.monitor_id = monitor.id;
        link.notification_id = notification.id;
        await R.store(link);

        require("../../server/notification").Notification.init();
    });

    t.after(async () => {
        telegram?.closeAllConnections?.();
        await new Promise((resolve) => telegram.close(() => resolve()));
        await flushNotifications(1000);
        await testDb.destroy();
    });

    await t.test("the transition returns and the heartbeat persists while Telegram hangs", async () => {
        const beat = R.dispense("heartbeat");
        beat.monitor_id = monitor.id;
        beat.status = 0;
        beat.msg = "connect ECONNREFUSED";
        beat.time = dayjs.utc().format("YYYY-MM-DD HH:mm:ss.SSS");
        beat.important = 1;
        await R.store(beat);

        const started = Date.now();
        await Monitor.sendNotification(true, monitor, beat);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 3000, `sendNotification took ${elapsed}ms; delivery must be queued, not awaited`);

        // The heartbeat is what the beat path writes next; it must not be
        // behind a pending delivery.
        await R.store(beat);
        const stored = await R.findOne("heartbeat", " id = ? ", [ beat.id ]);
        assert.ok(stored, "heartbeat persisted while the notification was still pending");

        // The hung delivery did reach the provider; releasing the reply lets
        // it settle (the queue never had to retry, so exactly one request).
        const requestDeadline = Date.now() + 3000;
        while (requests.length === 0 && Date.now() < requestDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.strictEqual(requests.length, 1, "the delivery was attempted while the beat path moved on");
        releaseReply();
        assert.strictEqual(await flushNotifications(5000), true, "the released delivery settles");
        assert.strictEqual(requests.length, 1, "the delivery was attempted");
        assert.ok(notificationCounters().delivered >= 1, "the late answer counts as delivered");
        assert.strictEqual(pendingNotifications(), 0);
    });
});

test("transient delivery failures are retried, permanent ones are not", async () => {
    const {
        enqueueNotification,
        flushNotifications,
        notificationCounters,
        classifyDeliveryFailure,
        MAX_ATTEMPTS,
    } = require("../../server/notification-queue");

    // A transient failure (network error, timeout, 5xx) is retried in place
    // until it succeeds; the follow-up finding reproduced a single timeout
    // dropping the alert forever.
    let attempts = 0;
    const deliveredBefore = notificationCounters().delivered;
    enqueueNotification("flaky", async () => {
        attempts++;
        if (attempts < 3) {
            const error = new Error("read ETIMEDOUT");
            throw error;
        }
    });
    assert.strictEqual(await flushNotifications(10000), true);
    assert.strictEqual(attempts, 3, "transient failures are retried");
    assert.strictEqual(notificationCounters().delivered, deliveredBefore + 1);

    // A permanent failure is one attempt: a bad token or chat id will fail
    // identically forever.
    let permanentAttempts = 0;
    enqueueNotification("bad-chat", async () => {
        permanentAttempts++;
        const error = new Error("Request failed with status code 400");
        error.response = { status: 400, data: { ok: false, description: "chat not found" } };
        throw error;
    });
    assert.strictEqual(await flushNotifications(10000), true);
    assert.strictEqual(permanentAttempts, 1, "a 4xx is not retried");

    // Rate limits are retried and the provider's hint is honoured.
    const limited = new Error("Request failed with status code 429");
    limited.response = { status: 429, data: { parameters: { retry_after: 30 } } };
    assert.deepStrictEqual(classifyDeliveryFailure(limited), { retryable: true, afterMs: 30_000 });
    const timedOut = Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" });
    assert.deepStrictEqual(classifyDeliveryFailure(timedOut), { retryable: true, afterMs: null });

    // And the counter arithmetic is visible for diagnostics.
    const stats = require("../../server/notification-queue").notificationQueueStats();
    assert.ok(stats.retries >= 1, "retries are counted");
    assert.ok(stats.failed >= 1, "abandoned deliveries are counted");
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.oldestAgeMs, null);
    assert.ok(MAX_ATTEMPTS >= 2);
});

test("shutdown drains the queue instead of dropping accepted alerts", async () => {
    const { enqueueNotification, flushNotifications } = require("../../server/notification-queue");

    // The shutdown path calls flushNotifications() with a bounded timeout
    // (server.js). Here: a delivery that takes a moment still completes, and
    // the flush reports success; an unreachable provider cannot hang it past
    // the bound.
    let delivered = false;
    enqueueNotification("slow-but-fine", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        delivered = true;
    });
    assert.strictEqual(await flushNotifications(2000), true, "a pending delivery drains");
    assert.strictEqual(delivered, true, "and is not lost on the way out");

    // A queue that cannot finish is reported, not awaited forever.
    enqueueNotification("hangs", () => new Promise(() => {}));
    assert.strictEqual(await flushNotifications(200), false, "the flush is bounded");
});

test("the notification queue is bounded and axios gets a deadline", async () => {
    const {
        enqueueNotification,
        pendingNotifications,
        notificationCounters,
        MAX_QUEUE,
    } = require("../../server/notification-queue");
    const NotificationProvider = require("../../server/notification-providers/notification-provider");
    const axios = require("axios");
    const provider = new NotificationProvider();

    // A bounded default: axios' installed default of 0 means "wait forever".
    const config = provider.getAxiosConfigWithProxy();
    assert.ok(config.timeout > 0, "notification requests must have a deadline");
    assert.ok(config.timeout <= 60_000);
    assert.strictEqual(provider.getAxiosConfigWithProxy({ timeout: 1234 }).timeout, 1234, "callers may override");

    // And axios honors it: a server that accepts and withholds the response
    // must not hold the request open.
    const blackhole = http.createServer((req, res) => {
        // Never answer.
    });
    await new Promise((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
    try {
        const started = Date.now();
        await assert.rejects(
            axios.post(`http://127.0.0.1:${blackhole.address().port}/x`, {}, provider.getAxiosConfigWithProxy({ timeout: 200 })),
            /timeout/i
        );
        assert.ok(Date.now() - started < 3000, "the deadline must abort the request");
    } finally {
        blackhole.closeAllConnections?.();
        await new Promise((resolve) => blackhole.close(resolve));
    }

    // One worker is parked on a delivery that never settles; the queue must
    // still refuse to grow past its bound. Fill until the first refusal
    // (earlier tests may have left a delivery waiting) and assert the bound
    // and the drop count, not the absolute fill level.
    const droppedBefore = notificationCounters().dropped;
    enqueueNotification("hangs forever", () => new Promise(() => {}));
    let accepted = 0;
    while (enqueueNotification(`filler ${accepted}`, async () => {})) {
        accepted++;
        if (accepted > MAX_QUEUE + 5) {
            break;
        }
    }
    assert.ok(accepted > 0, "the queue accepts deliveries");
    assert.ok(pendingNotifications() <= MAX_QUEUE, "never exceeds its bound");
    assert.strictEqual(notificationCounters().dropped, droppedBefore + 1, "the overflow is dropped and counted");
});
