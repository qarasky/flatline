/**
 * Metric threshold alerts (Superboard Phase 5).
 *
 * Unit tests cover the pure state machine; the integration test drives the
 * real push endpoint into a recording Telegram stub, proving the wiring:
 * debounce, cooldown repeat, and recovery messages.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB("./data/test-metric-alerts");

test("metric alert state machine", async (t) => {
    const { stepMetric, readingsFrom, formatMetricMessage, DEBOUNCE_MS, COOLDOWN_MS } =
        require("../../server/metric-alerts");
    const t0 = 1_760_000_000_000;
    const fresh = () => ({ breachedSince: null, alerted: false, lastNotified: 0 });

    await t.test("debounce: a short spike never alerts, sustained does", async () => {
        const s = fresh();
        assert.strictEqual(stepMetric(s, 95, 90, t0), null, "breach start is silent");
        assert.strictEqual(stepMetric(s, 95, 90, t0 + DEBOUNCE_MS - 1), null, "before debounce is silent");
        assert.strictEqual(stepMetric(s, 95, 90, t0 + DEBOUNCE_MS), "alert");
    });

    await t.test("spike below debounce resets the episode", async () => {
        const s = fresh();
        stepMetric(s, 95, 90, t0);
        assert.strictEqual(stepMetric(s, 80, 90, t0 + 30_000), null, "dropped before alert: no recovery message");
        assert.strictEqual(s.breachedSince, null, "episode reset");
        stepMetric(s, 95, 90, t0 + 120_000);
        assert.strictEqual(stepMetric(s, 95, 90, t0 + 179_999), null);
        assert.strictEqual(stepMetric(s, 95, 90, t0 + 180_000), "alert", "fresh debounce from the new episode");
    });

    await t.test("while breached, repeats at most every cooldown", async () => {
        const s = fresh();
        stepMetric(s, 95, 90, t0);
        assert.strictEqual(stepMetric(s, 95, 90, t0 + DEBOUNCE_MS), "alert");
        s.alerted = true;
        s.lastNotified = t0 + DEBOUNCE_MS;
        assert.strictEqual(stepMetric(s, 95, 90, t0 + DEBOUNCE_MS + 1000), null);
        assert.strictEqual(stepMetric(s, 95, 90, t0 + DEBOUNCE_MS + COOLDOWN_MS - 1), null);
        assert.strictEqual(stepMetric(s, 95, 90, t0 + DEBOUNCE_MS + COOLDOWN_MS), "alert");
    });

    await t.test("hysteresis band stays silent; recovery needs threshold - 5", async () => {
        const s = fresh();
        stepMetric(s, 95, 90, t0);
        stepMetric(s, 95, 90, t0 + DEBOUNCE_MS);
        s.alerted = true;
        s.lastNotified = t0 + DEBOUNCE_MS;
        assert.strictEqual(stepMetric(s, 88, 90, t0 + DEBOUNCE_MS + 1000), null, "band: no repeat, no recovery");
        assert.strictEqual(stepMetric(s, 86, 90, t0 + DEBOUNCE_MS + 2000), null, "still in band");
        assert.strictEqual(stepMetric(s, 85, 90, t0 + DEBOUNCE_MS + 3000), "recover");
        assert.strictEqual(s.alerted, false, "episode closed");
        assert.strictEqual(stepMetric(s, 85, 90, t0 + DEBOUNCE_MS + 4000), null, "no double recovery");
    });

    await t.test("missing readings leave episodes untouched", async () => {
        const s = fresh();
        stepMetric(s, 95, 90, t0);
        stepMetric(s, 95, 90, t0 + DEBOUNCE_MS);
        s.alerted = true;
        s.lastNotified = t0 + DEBOUNCE_MS;
        assert.strictEqual(stepMetric(s, null, 90, t0 + DEBOUNCE_MS + 1000), null);
        assert.notStrictEqual(s.breachedSince, null, "absent metric must not fake a recovery");
        assert.strictEqual(s.alerted, true);
    });

    await t.test("readingsFrom takes the fullest mount and rejects garbage", async () => {
        const r = readingsFrom({
            cpu: { percent: 50 }, mem: { percent: 80 },
            disk: [ { mount: "/", percent: 42 }, { mount: "/data", percent: 93.5 } ],
        });
        assert.deepStrictEqual(r, { cpu: 50, ram: 80, disk: 93.5, diskMount: "/data" });
        const empty = readingsFrom({ cpu: { percent: NaN }, disk: [ { mount: "/", percent: "x" } ] });
        assert.deepStrictEqual(empty, { cpu: null, ram: null, disk: null, diskMount: null });
        assert.deepStrictEqual(readingsFrom(null), { cpu: null, ram: null, disk: null, diskMount: null });
    });

    await t.test("message formats mirror heartbeat alerts", async () => {
        assert.strictEqual(
            formatMetricMessage("web-01", "cpu", null, 94.23, 90, "alert"),
            "[web-01] [⚠️ Metric] CPU 94.2% ≥ threshold 90%");
        assert.strictEqual(
            formatMetricMessage("web-01", "disk", "/data", 93.5, 90, "alert"),
            "[web-01] [⚠️ Metric] Disk /data 93.5% ≥ threshold 90%");
        assert.strictEqual(
            formatMetricMessage("web-01", "cpu", null, 72.14, 90, "recover"),
            "[web-01] [✅ Metric] CPU recovered: 72.1% (threshold 90%)");
    });
});

test("metric alerts deliver through the push endpoint", async (t) => {
    const express = require("express");
    const { R } = require("redbean-node");
    const { auth } = require("../../server/better-auth");
    let base = "";
    let server: any = null;
    let recorder: any = null;
    let pushToken = "metric-alert-token";
    const messages: any[] = [];

    t.before(async () => {
        await testDb.create();
        await auth();
        await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: { username: "admin" },
            },
        });

        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        UptimeKumaServer.getInstance().io = { sockets: null, to: () => ({ emit: () => {} }) };
        // The real server calls this at boot; tests must too, or the static
        // provider registry is empty and every notification send fails.
        require("../../server/notification").Notification.init();

        const app = express();
        app.use(require("../../server/routers/api-router"));
        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });
        base = `http://127.0.0.1:${server.address().port}`;

        // Recording Telegram stub: every message is kept for assertions.
        const recorderApp = express();
        recorderApp.use(express.json());
        recorderApp.post("/*", (req: any, res: any) => {
            messages.push(req.body);
            res.json({ ok: true, result: { message_id: messages.length } });
        });
        recorder = await new Promise<any>((resolve) => {
            const s = recorderApp.listen(0, "127.0.0.1", () => resolve(s));
        });

        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Alert Host";
        monitor.type = "push";
        monitor.interval = 180;
        monitor.retryInterval = 180;
        monitor.timeout = 144;
        monitor.active = 1;
        monitor.push_token = pushToken;
        monitor.metric_cpu_threshold = 90;
        await R.store(monitor);

        const notification = R.dispense("notification");
        notification.name = "TestTelegram";
        notification.active = 1;
        notification.user_id = owner.id;
        notification.is_default = 0;
        notification.config = JSON.stringify({
            type: "telegram",
            telegramBotToken: "test-token",
            telegramChatID: "12345",
            telegramServerUrl: `http://127.0.0.1:${recorder.address().port}`,
        });
        await R.store(notification);

        const link = R.dispense("monitor_notification");
        link.monitor_id = monitor.id;
        link.notification_id = notification.id;
        await R.store(link);

        const { resetMetricAlerts } = require("../../server/metric-alerts");
        const { resetMetricsCache } = require("../../server/monitor-metrics");
        resetMetricAlerts();
        resetMetricsCache();
    });

    t.after(async () => {
        // Keep-alive connections (axios for Telegram, undici for fetch) hold
        // the servers open; close them explicitly or the test process hangs.
        server.closeAllConnections?.();
        recorder.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => recorder.close(() => resolve()));
        await testDb.destroy();
    });

    const push = (cpu: number) =>
        fetch(`${base}/api/push/${pushToken}?telemetry=1`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metrics: { v: 1, cpu: { percent: cpu }, mem: { percent: 20 } } }),
        });

    const waitFor = async (count: number, attempts = 200) => {
        // Deliberately not Date.now-based: the test mocks Date.now, and a
        // frozen clock would make a time-based deadline spin forever.
        for (let i = 0; i < attempts && messages.length < count; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };

    await t.test("debounce, repeat, recovery, in that order", async (st) => {
        let fakeNow = Date.now();
        st.mock.method(Date, "now", () => fakeNow);

        await push(95); // breach starts; silent
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(messages.length, 0, "a fresh breach must not alert immediately");

        fakeNow += 61_000;
        await push(95); // debounce passed -> alert
        await waitFor(1);
        assert.strictEqual(messages.length, 1, "sustained breach must alert");
        assert.match(messages[0].text, /\[Alert Host\] \[⚠️ Metric\] CPU 95% ≥ threshold 90%/);

        fakeNow += 60_000;
        await push(95); // within cooldown -> silent
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(messages.length, 1, "cooldown must suppress repeats");

        fakeNow += 30 * 60_000;
        await push(95); // cooldown elapsed -> repeat
        await waitFor(2);
        assert.strictEqual(messages.length, 2, "sustained breach must repeat after the cooldown");

        fakeNow += 1000;
        await push(50); // recovery
        await waitFor(3);
        assert.strictEqual(messages.length, 3, "recovery must be announced");
        assert.match(messages[2].text, /\[✅ Metric\] CPU recovered: 50% \(threshold 90%\)/);
    });
});
