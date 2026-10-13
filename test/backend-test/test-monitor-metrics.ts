/**
 * Tests for Superboard metrics ingest (Phase 1).
 *
 * Covers the migration, the validate/store/prune unit layer, and the push
 * endpoint itself mounted on an ephemeral express app — including the key
 * property that a broken metrics payload never sinks the heartbeat.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

/** Minimal broadcast stub: the push endpoint used to emit over sockets. */
function fakeIo() {
    return {
        sockets: null,
        to: () => ({ emit: () => {} }),
    };
}

test("monitor metrics ingest", async (t) => {
    let base = "";
    let server: any = null;
    let pushToken = "";

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

        // The push router captures `io` at require time, so stub it first.
        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        UptimeKumaServer.getInstance().io = fakeIo();

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/api-router"));
        app.use(require("../../server/routers/api-v1-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address();
        base = `http://127.0.0.1:${address.port}`;

        const { R } = require("redbean-node");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const bean = R.dispense("monitor");
        bean.user_id = owner.id;
        bean.name = "Agent Host";
        bean.type = "push";
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.timeout = 48;
        bean.active = 1;
        bean.push_token = "test-push-token-123";
        await R.store(bean);
        pushToken = "test-push-token-123";
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const push = async (body: any, query = "") => {
        const res = await fetch(`${base}/api/push/${pushToken}${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    const metricRows = async () => {
        const { R } = require("redbean-node");
        return await R.getAll("SELECT * FROM monitor_metric ORDER BY id");
    };

    await t.test("migration creates the table with an index", async () => {
        const { R } = require("redbean-node");
        const info = await R.knex("monitor_metric").columnInfo();
        const names = Object.keys(info);
        for (const col of [ "id", "monitor_id", "time", "payload" ]) {
            assert.ok(names.includes(col), `${col} missing`);
        }
    });

    await t.test("a plain push still works and stores no metrics", async () => {
        const { status, body } = await push({}, "?msg=OK&status=up");
        assert.strictEqual(status, 200);
        assert.strictEqual(body.ok, true);
        assert.strictEqual((await metricRows()).length, 0);
    });

    await t.test("a push with metrics stores both", async () => {
        const metrics = {
            v: 1,
            host: { hostname: "client-a-db-01", os: "linux", uptime: 864001 },
            cpu: { percent: 23.5, cores: 8 },
            mem: { total: 33554432, used: 12582912, percent: 37.5 },
            disk: [ { mount: "/", total: 100, used: 42, percent: 42 } ],
            gpu: { available: false },
            docker: [ { name: "api", image: "api:1.4.2", state: "running", health: "healthy", ports: [ "8080:80" ] } ],
        };
        const { status, body } = await push({ status: "up", ping: 12, msg: "OK", metrics });
        assert.strictEqual(status, 200);
        assert.strictEqual(body.ok, true);

        const rows = await metricRows();
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(JSON.parse(rows[0].payload), metrics);
    });

    await t.test("malformed metrics 400 but the heartbeat is still recorded", async () => {
        const { R } = require("redbean-node");
        const beatsBefore = (await R.getAll("SELECT * FROM heartbeat")).length;

        const { status, body } = await push({ status: "up", metrics: [ "not", "an", "object" ] });
        assert.strictEqual(status, 400);
        assert.strictEqual(body.ok, false);
        assert.match(body.msg, /Heartbeat recorded, metrics dropped/);

        const beatsAfter = (await R.getAll("SELECT * FROM heartbeat")).length;
        assert.strictEqual(beatsAfter, beatsBefore + 1, "heartbeat must survive bad metrics");
        assert.strictEqual((await metricRows()).length, 1, "no metrics row for the bad payload");
    });

    await t.test("oversized metrics are rejected without recording", async () => {
        const big = { v: 1, blob: "x".repeat(70 * 1024) };
        const { status } = await push({ status: "up", metrics: big });
        assert.strictEqual(status, 400);
        assert.strictEqual((await metricRows()).length, 1);
    });

    await t.test("validateMetrics accepts unknown future fields", async () => {
        const { validateMetrics } = require("../../server/monitor-metrics");
        const out = validateMetrics({ v: 99, somethingNew: [ 1, 2, 3 ] });
        assert.deepStrictEqual(JSON.parse(out), { v: 99, somethingNew: [ 1, 2, 3 ] });
    });

    await t.test("pruneMetrics deletes only old rows", async () => {
        const { R } = require("redbean-node");
        const { pruneMetrics } = require("../../server/monitor-metrics");

        const old = R.dispense("monitor_metric");
        old.monitor_id = 1;
        old.time = "2000-01-01 00:00:00";
        old.payload = JSON.stringify({ v: 1 });
        await R.store(old);

        await pruneMetrics(30);

        const rows = await metricRows();
        assert.ok(rows.length >= 1, "recent rows survive");
        assert.ok(!rows.some((r: any) => r.time.startsWith("2000-")), "old row pruned");
    });

    await t.test("live telemetry updates latest without one heartbeat/history row per sample", async () => {
        const { R } = require("redbean-node");
        const { getLatestMetrics } = require("../../server/monitor-metrics");
        const beforeBeats = Number(await R.count("heartbeat"));
        const beforeMetrics = (await metricRows()).length;
        for (let i = 0; i < 10; i++) {
            const result = await push({ metrics: { v: 1, sampleInterval: 1, cpu: { percent: i } } }, "?telemetry=1");
            assert.strictEqual(result.status, 200);
        }
        assert.strictEqual(Number(await R.count("heartbeat")), beforeBeats);
        assert.strictEqual((await metricRows()).length, beforeMetrics);
        const monitor = await R.findOne("monitor", " push_token = ? ", [pushToken]);
        assert.strictEqual(getLatestMetrics(monitor.id).metrics.cpu.percent, 9);
        const bad = await push({ metrics: [] }, "?telemetry=1");
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(getLatestMetrics(monitor.id).metrics.cpu.percent, 9);
    });

    await t.test("concurrent live samples archive once, not once per request", async (st) => {
        // The audit's reproduction with delayed persistence: every request
        // read the same stale archive clock before awaiting storage, so ten
        // concurrent samples produced ten archive rows. Ingestion is now
        // serialized per monitor, so the gate holds however requests
        // interleave.
        const { R } = require("redbean-node");
        const { storeMetrics, getLatestMetrics, resetMetricsCache } = require("../../server/monitor-metrics");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Concurrent Host";
        monitor.type = "push";
        monitor.interval = 180;
        monitor.retryInterval = 180;
        monitor.timeout = 144;
        monitor.active = 1;
        await R.store(monitor);
        resetMetricsCache();

        // Delay storage to widen the interleaving window the audit used.
        const originalStore = R.store;
        st.mock.method(R, "store", async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return originalStore.apply(R, args);
        });

        const time = new Date().toISOString().replace("T", " ").replace("Z", "");
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
            storeMetrics(monitor.id, time, { v: 1, cpu: { percent: i }, mem: { percent: 20 } }, { live: true })));

        const rows = await R.getAll("SELECT id, time, payload FROM monitor_metric WHERE monitor_id = ?", [ monitor.id ]);
        assert.strictEqual(rows.length, 1, `expected one archive row, got ${rows.length}`);
        // The latest cache still reflects the committed sample.
        assert.ok(getLatestMetrics(monitor.id), "latest sample cached");

        await R.exec("DELETE FROM monitor_metric WHERE monitor_id = ?", [ monitor.id ]);
    });

    await t.test("resolveSampleTime accepts sane agent times and rejects the rest", async () => {
        const { resolveSampleTime } = require("../../server/monitor-metrics");
        const now = Date.parse("2026-10-12T12:00:00Z");
        assert.strictEqual(resolveSampleTime("2026-10-12T11:59:59.500Z", now), "2026-10-12 11:59:59.500");
        assert.strictEqual(resolveSampleTime("2026-10-12 11:00:00", now), "2026-10-12 11:00:00.000");
        assert.strictEqual(resolveSampleTime("2026-10-12T12:06:00Z", now), null, "6 minutes ahead is clock skew");
        assert.strictEqual(resolveSampleTime("2026-09-01T00:00:00Z", now), null, "older than retention");
        assert.strictEqual(resolveSampleTime("garbage", now), null);
        assert.strictEqual(resolveSampleTime(undefined, now), null);
        assert.strictEqual(resolveSampleTime(12345, now), null);
    });

    await t.test("a backfilled push stores the sample time; the heartbeat keeps receive time", async () => {
        const { R } = require("redbean-node");
        const { getLatestMetrics } = require("../../server/monitor-metrics");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Backfill Host";
        monitor.type = "push";
        monitor.interval = 180;
        monitor.retryInterval = 180;
        monitor.timeout = 144;
        monitor.active = 1;
        monitor.push_token = "test-backfill-token";
        await R.store(monitor);

        const sampledAt = new Date(Date.now() - 90_000).toISOString();
        const res = await fetch(`${base}/api/push/test-backfill-token?telemetry=1`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metrics: { v: 1, sampledAt, cpu: { percent: 5 } } }),
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(getLatestMetrics(monitor.id).time, sampledAt.replace("T", " ").replace("Z", ""));

        const Monitor = require("../../server/model/monitor");
        const beat = await Monitor.getPreviousHeartbeat(monitor.id);
        const beatAge = Date.now() - Date.parse(beat.time.replace(" ", "T") + "Z");
        assert.ok(beatAge < 10_000, `heartbeat must use receive time, got age ${beatAge}ms`);
    });

    await t.test("buffered backfill archives at sample cadence, not receive-time bursts", async (st) => {
        const { R } = require("redbean-node");
        const { storeMetrics, resetMetricsCache } = require("../../server/monitor-metrics");
        resetMetricsCache();
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);

        const makeHost = async (name: string, token: string) => {
            const monitor = R.dispense("monitor");
            monitor.user_id = owner.id;
            monitor.name = name;
            monitor.type = "push";
            monitor.interval = 180;
            monitor.retryInterval = 180;
            monitor.timeout = 144;
            monitor.active = 1;
            monitor.push_token = token;
            await R.store(monitor);
            return monitor;
        };

        let fakeNow = Date.now();
        st.mock.method(Date, "now", () => fakeNow);
        const sql = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

        // Six samples 30s apart in sample time, delivered within milliseconds
        // of each other: each sample-gap triggers its own archive row.
        const backfill = await makeHost("Backfill Cadence", "test-cadence-token");
        const t0 = fakeNow - 3 * 3600_000;
        for (let i = 0; i < 6; i++) {
            await storeMetrics(backfill.id, sql(t0 + i * 30_000), { v: 1, cpu: { percent: 10 + i } }, { live: true });
        }
        const rows = await R.getAll("SELECT time FROM monitor_metric WHERE monitor_id = ? ORDER BY time", [ backfill.id ]);
        assert.strictEqual(rows.length, 6, "one archive row per 30s of sample time");
        assert.strictEqual(rows[0].time, sql(t0));
        assert.strictEqual(rows[5].time, sql(t0 + 150_000));

        // Control: six samples one second apart in sample time collapse to
        // the normal 30s archive cadence (first sample only, wall clock is
        // frozen).
        const dense = await makeHost("Dense Backfill", "test-dense-token");
        for (let i = 0; i < 6; i++) {
            await storeMetrics(dense.id, sql(t0 + i * 1000), { v: 1, cpu: { percent: 20 + i } }, { live: true });
        }
        const denseRows = await R.getAll("SELECT time FROM monitor_metric WHERE monitor_id = ? ORDER BY time", [ dense.id ]);
        assert.strictEqual(denseRows.length, 1, "sub-30s samples must not flood history");
    });
});

test("monitor metrics read API", async (t) => {
    let base = "";
    let server: any = null;
    let token = "";
    let monitorID = 0;

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
        UptimeKumaServer.getInstance().io = fakeIo();

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/api-v1-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address();
        base = `http://127.0.0.1:${address.port}`;

        const { R } = require("redbean-node");
        const passwordHash = require("../../server/password-hash");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);

        const key = R.dispense("api_key");
        key.key = await passwordHash.generate("read-secret");
        key.name = "reader";
        key.user_id = owner.id;
        key.active = true;
        key.expires = null;
        key.scopes = "read";
        await R.store(key);
        token = `uk${key.id}_read-secret`;

        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Metric Host";
        monitor.type = "push";
        monitor.interval = 60;
        monitor.retryInterval = 60;
        monitor.timeout = 48;
        monitor.active = 1;
        await R.store(monitor);
        monitorID = monitor.id;

        // Three samples: two recent, one older than a day.
        const { storeMetrics } = require("../../server/monitor-metrics");
        const now = Date.now();
        const at = (minsAgo: number) =>
            new Date(now - minsAgo * 60000).toISOString().slice(0, 19).replace("T", " ");
        await storeMetrics(monitorID, at(10), { v: 1, cpu: { percent: 20, cores: 4 } });
        await storeMetrics(monitorID, at(70), { v: 1, cpu: { percent: 40, cores: 4 } });
        await storeMetrics(monitorID, at(1500), { v: 1, cpu: { percent: 90, cores: 4 } });
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const get = async (path: string, authToken: string | null = token) => {
        const res = await fetch(`${base}${path}`, {
            headers: {
                Accept: "application/json",
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
        });
        return { status: res.status, body: await res.json() };
    };

    await t.test("latest returns the newest sample", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics/latest`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.monitorId, monitorID);
        assert.strictEqual(body.metrics.cpu.percent, 20);
    });

    await t.test("latest 404s when there are no samples", async () => {
        const { R } = require("redbean-node");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        const empty = R.dispense("monitor");
        empty.user_id = owner.id;
        empty.name = "No Samples";
        empty.type = "push";
        empty.interval = 60;
        empty.retryInterval = 60;
        empty.timeout = 48;
        empty.active = 1;
        await R.store(empty);

        const { status, body } = await get(`/api/v1/monitors/${empty.id}/metrics/latest`);
        assert.strictEqual(status, 404);
        assert.strictEqual(body.ok, false);
    });

    await t.test("history defaults to 24h and excludes older samples", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.hours, 24);
        assert.strictEqual(body.count, 2, "the 25-hour-old sample is outside the window");
        assert.strictEqual(body.capped, false);
        // Newest first.
        assert.strictEqual(body.metrics[0].metrics.cpu.percent, 20);
        assert.strictEqual(body.metrics[1].metrics.cpu.percent, 40);
    });

    await t.test("history honours a wider window", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics?hours=48`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 3);
    });

    await t.test("history rejects a bad window", async () => {
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics?hours=nope`)).status, 400);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics?hours=-5`)).status, 400);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics?hours=0`)).status, 400);
    });

    await t.test("history caps hours at a week", async () => {
        // 10000 asks for more than exists; the cap is what matters, not the data.
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics?hours=10000`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 3, "all rows fit, cap only bounds the window");
    });

    await t.test("both endpoints require auth", async () => {
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics/latest`, null)).status, 401);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics`, null)).status, 401);
    });

    await t.test("both endpoints 404 an unknown monitor", async () => {
        assert.strictEqual((await get("/api/v1/monitors/999999/metrics/latest")).status, 404);
        assert.strictEqual((await get("/api/v1/monitors/999999/metrics")).status, 404);
    });

    await t.test("bulk latest returns samples keyed by id, null where missing", async () => {
        const { status, body } = await get(`/api/v1/monitors/metrics/latest?ids=${monitorID},999999`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 2);
        assert.strictEqual(body.samples[monitorID].metrics.cpu.percent, 20);
        assert.strictEqual(body.samples["999999"], null);
    });

    await t.test("bulk latest ignores garbage ids and requires at least one", async () => {
        assert.strictEqual((await get("/api/v1/monitors/metrics/latest")).status, 400);
        assert.strictEqual((await get("/api/v1/monitors/metrics/latest?ids=nope")).status, 400);
        const { status, body } = await get(`/api/v1/monitors/metrics/latest?ids=nope,${monitorID},${monitorID}`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 1, "garbage dropped, duplicates collapsed");
    });

    await t.test("bulk latest requires auth", async () => {
        assert.strictEqual((await get(`/api/v1/monitors/metrics/latest?ids=${monitorID}`, null)).status, 401);
    });

    await t.test("cold-cache latest falls back to indexed durable history", async () => {
        require("../../server/monitor-metrics").forgetMetrics(monitorID);
        const { body } = await get(`/api/v1/monitors/metrics/latest?ids=${monitorID}`);
        assert.strictEqual(body.samples[monitorID].metrics.cpu.percent, 20);
    });

    await t.test("live stream requires header auth, never a token in the URL", async () => {
        assert.strictEqual((await fetch(`${base}/api/v1/events`)).status, 401);
        assert.strictEqual((await fetch(`${base}/api/v1/events?token=${token}`)).status, 401);
    });

    await t.test("live stream sends committed deltas with no buffering", async () => {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/v1/events`, { headers:{Authorization:`Bearer ${token}`}, signal:controller.signal });
        const reader = response.body!.getReader();
        try {
            assert.match(response.headers.get("content-type")!, /text\/event-stream/);
            assert.strictEqual(response.headers.get("x-accel-buffering"), "no");
            assert.match(new TextDecoder().decode((await reader.read()).value), /"ready"/);
            const pending = reader.read();
            const { storeMetrics } = require("../../server/monitor-metrics");
            await storeMetrics(monitorID, new Date().toISOString(), {v:1, cpu:{percent:73}}, {live:true});
            const frame = new TextDecoder().decode((await pending).value);
            assert.match(frame, /"metrics"/);
            assert.match(frame, /"percent":73/);
            assert.match(frame, new RegExp(`"monitorId":${monitorID}`));
        } finally { controller.abort(); await reader.cancel().catch(() => {}); }
    });

    await t.test("live streams are bounded per key even for concurrent opens", async () => {
        const controllers = Array.from({length:9}, () => new AbortController());
        try {
            const responses = await Promise.all(controllers.map(c => fetch(`${base}/api/v1/events`, {headers:{Authorization:`Bearer ${token}`}, signal:c.signal})));
            assert.strictEqual(responses.filter(r => r.status === 200).length, 8);
            assert.strictEqual(responses.filter(r => r.status === 429).length, 1);
        } finally { controllers.forEach(c => c.abort()); }
        await new Promise(resolve => setTimeout(resolve, 30));
    });

    await t.test("revocation closes an existing live stream at revalidation", async (st) => {
        const { R } = require("redbean-node");
        const keyID = Number(token.split("_")[0].slice(2));
        const controller = new AbortController();
        st.mock.timers.enable({apis:["setInterval"]});
        const response = await fetch(`${base}/api/v1/events`, {headers:{Authorization:`Bearer ${token}`}, signal:controller.signal});
        const reader = response.body!.getReader();
        try {
            await reader.read();
            await R.exec("UPDATE api_key SET active = 0 WHERE id = ?", [keyID]);
            const ended = reader.read().then(r => r.done || new TextDecoder().decode(r.value).includes("unauthorized"), () => true);
            st.mock.timers.tick(15_000);
            assert.strictEqual(await ended, true);
        } finally {
            controller.abort();
            await R.exec("UPDATE api_key SET active = 1 WHERE id = ?", [keyID]);
            st.mock.timers.reset();
        }
    });

    await t.test("latest cache compares actual times across ISO and SQL timestamp formats", async () => {
        const { storeMetrics, getLatestMetrics } = require("../../server/monitor-metrics");
        await storeMetrics(monitorID, "2099-01-01T00:00:00Z", {cpu:{percent:1}}, {live:true});
        await storeMetrics(monitorID, "2099-01-01 00:00:01", {cpu:{percent:2}}, {live:true});
        await storeMetrics(monitorID, "2099-01-01T00:00:00.500Z", {cpu:{percent:3}}, {live:true});
        assert.strictEqual(getLatestMetrics(monitorID).metrics.cpu.percent, 2);
    });

    await t.test("summary includes more than 1000 archived samples and full-window percentiles", async () => {
        const { R } = require("redbean-node");
        const monitor = R.dispense("monitor");
        monitor.name = "Summary host"; monitor.type = "push"; monitor.interval = 180;
        monitor.retryInterval = 180; monitor.timeout = 144; monitor.active = 0;
        await R.store(monitor);
        const now = Date.now() - 1000;
        const values = [];
        for (let i=0;i<1500;i++) {
            values.push(monitor.id, new Date(now-i*1000).toISOString().replace("T"," ").replace("Z",""), JSON.stringify({cpu:{percent:i%100},mem:{percent:50},gpu:i===0 ? {available:true,gpus:[{util:0,memUsed:10,memTotal:100}]} : {available:false}}));
        }
        await R.exec(`INSERT INTO monitor_metric (monitor_id,time,payload) VALUES ${Array(1500).fill("(?,?,?)").join(",")}`, values);
        const { status, body } = await get(`/api/v1/monitors/${monitor.id}/metrics/summary?hours=1`);
        assert.strictEqual(status,200); assert.strictEqual(body.samples,1500); assert.strictEqual(body.capped,false);
        assert.strictEqual(body.stats.cpu.p90,89); assert.strictEqual(body.stats.cpu.p95,94); assert.strictEqual(body.stats.cpu.p99,98);
        assert.strictEqual(body.stats.gpu.count,1); assert.strictEqual(body.stats.gpu.p99,0);
        assert.strictEqual(body.stats.vram.p99,10); assert.ok(body.series.length<=240);
        assert.strictEqual((await get(`/api/v1/monitors/${monitor.id}/metrics/summary?hours=0`)).status,400);
        assert.strictEqual((await get(`/api/v1/monitors/${monitor.id}/metrics/summary?hours=17521`)).status,400);
        assert.strictEqual((await get(`/api/v1/monitors/${monitor.id}/metrics/summary`,null)).status,401);
    });

    await t.test("banned accounts cannot open streams using previously minted tokens", async () => {
        const { R } = require("redbean-node");
        const key = await R.findOne("api_key", " id = ? ", [Number(token.split("_")[0].slice(2))]);
        try {
            await R.exec("UPDATE better_auth_user SET banned = 1 WHERE id = ?", [key.user_id]);
            const response = await fetch(`${base}/api/v1/events`, {headers:{Authorization:`Bearer ${token}`}});
            assert.strictEqual(response.status, 401);
        } finally { await R.exec("UPDATE better_auth_user SET banned = 0 WHERE id = ?", [key.user_id]); }
    });
});
