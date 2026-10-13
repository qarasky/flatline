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
        // The late answer keeps the test's process free to exit while still
        // exercising a delivery that takes far longer than a beat may wait.
        const app = express();
        app.use(express.json());
        app.post("/*", (req, res) => {
            requests.push(req.body);
            setTimeout(() => res.json({ ok: true, result: { message_id: requests.length } }), 1500);
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
        assert.ok(elapsed < 1000, `sendNotification took ${elapsed}ms; delivery must be queued, not awaited`);

        // The heartbeat is what the beat path writes next; it must not be
        // behind a pending delivery.
        await R.store(beat);
        const stored = await R.findOne("heartbeat", " id = ? ", [ beat.id ]);
        assert.ok(stored, "heartbeat persisted while the notification was still pending");

        // The hung delivery did reach the provider and settles on its own.
        assert.strictEqual(await flushNotifications(5000), true, "the hung delivery settles within its deadline");
        assert.strictEqual(requests.length, 1, "the delivery was attempted");
        assert.ok(notificationCounters().delivered >= 1, "the late answer counts as delivered");
        assert.strictEqual(pendingNotifications(), 0);
    });
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
    // still refuse to grow past its bound.
    const droppedBefore = notificationCounters().dropped;
    enqueueNotification("hangs forever", () => new Promise(() => {}));
    for (let i = 0; i < MAX_QUEUE; i++) {
        assert.strictEqual(enqueueNotification(`filler ${i}`, async () => {}), true);
    }
    assert.strictEqual(pendingNotifications(), MAX_QUEUE, "the queue fills to its bound");
    assert.strictEqual(enqueueNotification("overflow", async () => {}), false, "overflow is dropped, not queued");
    assert.strictEqual(notificationCounters().dropped, droppedBefore + 1, "drops are counted");
});
