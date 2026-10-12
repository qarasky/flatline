/**
 * Hourly rollups and the two-tier history API.
 *
 * Unit tests cover payload extraction and bucket math; integration tests run
 * the real rollup job against a real database and read the long tier back
 * through the summary endpoint.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB("./data/test-metrics-rollup");

const HOUR = 3600_000;

/** SQL timestamp for epoch millis, matching stored format. */
const sql = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

test("rollup helpers", async (t) => {
    const { aggregateChunk, bucketRow, hourStart } = require("../../server/metrics-rollup");
    const { readingsFromPayload } = require("../../server/metrics-history");

    await t.test("readingsFromPayload mirrors the SQL extraction rules", async () => {
        assert.deepStrictEqual(
            readingsFromPayload(JSON.stringify({ cpu: { percent: 23.5 }, mem: { percent: 40 }, gpu: { available: false } })),
            { cpu: 23.5, ram: 40, gpu: null, vram: null });

        // gpus[0] wins over the legacy scalar fields; VRAM is used/total.
        assert.deepStrictEqual(
            readingsFromPayload(JSON.stringify({
                cpu: { percent: 10 }, mem: { percent: 20 },
                gpu: { available: true, util: 99, memUsed: 9, memTotal: 9, gpus: [ { util: 60, memUsed: 1, memTotal: 4 } ] },
            })),
            { cpu: 10, ram: 20, gpu: 60, vram: 25 });

        // Legacy scalar-only GPU payloads still read.
        assert.deepStrictEqual(
            readingsFromPayload(JSON.stringify({ gpu: { available: true, util: 30, memUsed: 2, memTotal: 8 } })),
            { cpu: null, ram: null, gpu: 30, vram: 25 });

        assert.deepStrictEqual(readingsFromPayload("{not json"),
            { cpu: null, ram: null, gpu: null, vram: null });
    });

    await t.test("aggregateChunk groups by monitor and hour with min/max/avg", async () => {
        const base = hourStart(Date.parse("2026-10-10T08:00:00Z"));
        const rows = [
            { monitor_id: 1, time: sql(base + 5 * 60_000), payload: JSON.stringify({ cpu: { percent: 10 }, mem: { percent: 50 } }) },
            { monitor_id: 1, time: sql(base + 35 * 60_000), payload: JSON.stringify({ cpu: { percent: 30 }, mem: { percent: 50 } }) },
            { monitor_id: 1, time: sql(base + 59 * 60_000), payload: JSON.stringify({ cpu: { percent: 20 } }) },
            { monitor_id: 2, time: sql(base + 10 * 60_000), payload: JSON.stringify({ cpu: { percent: 5 } }) },
            { monitor_id: 1, time: sql(base + HOUR + 60_000), payload: JSON.stringify({ cpu: { percent: 40 } }) },
            { monitor_id: 1, time: "garbage", payload: "{}" },
        ];
        const buckets = aggregateChunk(rows);
        assert.strictEqual(buckets.size, 3, "two hours for monitor 1, one for monitor 2");

        const first = bucketRow(buckets.get(`1|${base}`));
        assert.strictEqual(first.samples, 3);
        assert.strictEqual(first.cpu_min, 10);
        assert.strictEqual(first.cpu_max, 30);
        assert.strictEqual(first.cpu_avg, 20);
        assert.strictEqual(first.ram_min, 50);
        assert.strictEqual(first.ram_avg, 50, "missing ram on one row does not count as zero");
        assert.strictEqual(first.gpu_avg, null, "absent GPU stays null, never zero");

        const second = bucketRow(buckets.get(`1|${base + HOUR}`));
        assert.strictEqual(second.cpu_avg, 40);
        assert.strictEqual(second.samples, 1);
    });
});

test("rollup job folds raw samples into hourly buckets", async (t) => {
    const { R } = require("redbean-node");
    let monitorID = 0;

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
        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Rollup Host";
        monitor.type = "push";
        monitor.interval = 180;
        monitor.retryInterval = 180;
        monitor.timeout = 144;
        monitor.active = 1;
        await R.store(monitor);
        monitorID = monitor.id;
    });

    t.after(async () => {
        await testDb.destroy();
    });

    // A fixed "now" so bucket boundaries are deterministic.
    const now = Date.parse("2026-10-10T12:30:00Z");
    const hourA = Date.parse("2026-10-10T10:00:00Z");
    const hourB = Date.parse("2026-10-10T11:00:00Z");
    const currentHour = Date.parse("2026-10-10T12:00:00Z");

    const insertRaw = async (time: number, cpu: number, mem: number) => {
        const bean = R.dispense("monitor_metric");
        bean.monitor_id = monitorID;
        bean.time = sql(time);
        bean.payload = JSON.stringify({ cpu: { percent: cpu }, mem: { percent: mem } });
        await R.store(bean);
    };

    const buckets = async () => R.getAll(
        "SELECT * FROM monitor_metric_hourly WHERE monitor_id = ? ORDER BY time", [ monitorID ]);

    await t.test("folds complete hours only, with min/max/avg and sample counts", async () => {
        await insertRaw(hourA + 5 * 60_000, 10, 50);
        await insertRaw(hourA + 40 * 60_000, 30, 50);
        await insertRaw(hourA + 55 * 60_000, 20, 50);
        await insertRaw(hourB + 10 * 60_000, 40, 60);
        await insertRaw(currentHour + 10 * 60_000, 99, 99); // incomplete hour: must not roll up

        const { rollupMetrics } = require("../../server/metrics-rollup");
        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 2, "two complete hours fold; the current one waits");

        const rows = await buckets();
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].time, sql(hourA));
        assert.strictEqual(rows[0].cpu_min, 10);
        assert.strictEqual(rows[0].cpu_max, 30);
        assert.strictEqual(rows[0].cpu_avg, 20);
        assert.strictEqual(rows[0].ram_avg, 50);
        assert.strictEqual(rows[0].samples, 3);
        assert.strictEqual(rows[1].time, sql(hourB));
        assert.strictEqual(rows[1].cpu_avg, 40);
        assert.strictEqual(rows[1].samples, 1);
    });

    await t.test("re-runs are idempotent; late samples update the overlap hours", async () => {
        const { rollupMetrics } = require("../../server/metrics-rollup");
        await rollupMetrics(now);
        assert.strictEqual((await buckets()).length, 2, "no duplicate buckets");

        // A buffered agent delivers a late sample into an already-folded hour.
        await insertRaw(hourA + 58 * 60_000, 100, 50);
        await rollupMetrics(now);
        const rows = await buckets();
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].cpu_max, 100, "late sample must land via the overlap re-roll");
        assert.strictEqual(rows[0].samples, 4);
        assert.strictEqual(rows[0].cpu_avg, 40, "average recomputed over all four readings");
    });

    await t.test("expired rollups are pruned", async () => {
        const old = R.dispense("monitor_metric_hourly");
        old.monitor_id = monitorID;
        old.time = sql(Date.parse("2020-01-01T00:00:00Z"));
        old.samples = 1;
        await R.store(old);

        const { rollupMetrics } = require("../../server/metrics-rollup");
        const result = await rollupMetrics(now);
        assert.ok(result.pruned >= 1, "old bucket pruned");
        assert.ok(!(await buckets()).some((row: any) => row.time.startsWith("2020-")));
    });
});

test("summary reads the long tier beyond a week", async (t) => {
    const express = require("express");
    const { R } = require("redbean-node");
    let base = "";
    let server: any = null;
    let token = "";
    let monitorID = 0;

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
        const passwordHash = require("../../server/password-hash");
        const key = R.dispense("api_key");
        key.key = await passwordHash.generate("read-secret");
        key.name = "reader";
        key.user_id = owner.id;
        key.active = true;
        key.expires = null;
        key.scopes = "read";
        await R.store(key);
        token = `uk${key.id}_read-secret`;

        const app = express();
        app.use(require("../../server/routers/api-v1-router"));
        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });
        base = `http://127.0.0.1:${server.address().port}`;

        const monitor = R.dispense("monitor");
        monitor.user_id = owner.id;
        monitor.name = "Tier Host";
        monitor.type = "push";
        monitor.interval = 180;
        monitor.retryInterval = 180;
        monitor.timeout = 144;
        monitor.active = 1;
        await R.store(monitor);
        monitorID = monitor.id;

        // Ten days of hourly rollups: one bucket per hour with known extremes.
        const now = Date.now();
        const rows = [];
        for (let i = 1; i <= 240; i++) {
            const bucket = R.dispense("monitor_metric_hourly");
            bucket.monitor_id = monitorID;
            bucket.time = sql(now - i * HOUR);
            bucket.cpu_min = i % 100;
            bucket.cpu_max = 90;
            bucket.cpu_avg = 50;
            bucket.ram_min = 10;
            bucket.ram_max = 20;
            bucket.ram_avg = 15;
            bucket.samples = 120;
            rows.push(bucket);
        }
        for (const row of rows) {
            await R.store(row);
        }

        // A raw sample inside the last 24h, so the short tier has data too.
        const raw = R.dispense("monitor_metric");
        raw.monitor_id = monitorID;
        raw.time = sql(now - HOUR);
        raw.payload = JSON.stringify({ cpu: { percent: 42 }, mem: { percent: 24 } });
        await R.store(raw);
    });

    t.after(async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const get = async (path: string) => {
        const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json() };
    };

    await t.test("short windows stay on raw snapshots", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics/summary?hours=24`);
        assert.strictEqual(status, 200);
        assert.match(body.basis, /archived snapshots/);
        assert.strictEqual(body.samples, 1);
        assert.strictEqual(body.stats.cpu.mean, 42);
    });

    await t.test("long windows switch to hourly rollups with honest samples and peaks", async () => {
        const { status, body } = await get(`/api/v1/monitors/${monitorID}/metrics/summary?hours=720`);
        assert.strictEqual(status, 200);
        assert.match(body.basis, /hourly rollups/);
        assert.strictEqual(body.capped, false);
        assert.strictEqual(body.samples, 240 * 120, "sample count is the rolled-up raw readings");
        assert.strictEqual(body.stats.cpu.mean, 50, "percentiles describe hourly averages");
        assert.strictEqual(body.stats.cpu.max, 90, "peak stays the true maximum from the extremes");
        assert.strictEqual(body.stats.cpu.min, 0, "min comes from the extremes, not the averages");
        assert.ok(body.series.length <= 240);
        assert.ok(body.series.length > 0);
    });

    await t.test("two years is the long-tier limit", async () => {
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics/summary?hours=17520`)).status, 200);
        assert.strictEqual((await get(`/api/v1/monitors/${monitorID}/metrics/summary?hours=17521`)).status, 400);
    });
});
