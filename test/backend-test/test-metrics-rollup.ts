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

test("rollup coverage is per monitor and hour", async (t) => {
    const { R } = require("redbean-node");
    const { rollupMetrics, markRollupDirty } = require("../../server/metrics-rollup");
    const monitors: number[] = [];

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
        for (const name of [ "A", "B", "C" ]) {
            const monitor = R.dispense("monitor");
            monitor.user_id = owner.id;
            monitor.name = `Coverage ${name}`;
            monitor.type = "push";
            monitor.interval = 60;
            monitor.retryInterval = 60;
            monitor.timeout = 48;
            monitor.active = 1;
            await R.store(monitor);
            monitors.push(monitor.id);
        }
    });

    t.after(async () => {
        await testDb.destroy();
    });

    // A fixed "now": the two complete hours are 10:00 and 11:00, the four
    // hours 08:00-11:00 are all old enough that only real work re-folds them.
    const now = Date.parse("2026-10-10T12:30:00Z");
    const hour = (offset: number) => Date.parse("2026-10-10T08:00:00Z") + offset * HOUR;

    const insertRaw = async (monitorID: number, time: number, cpu: number) => {
        const bean = R.dispense("monitor_metric");
        bean.monitor_id = monitorID;
        bean.time = sql(time);
        bean.payload = JSON.stringify({ cpu: { percent: cpu }, mem: { percent: 50 } });
        await R.store(bean);
    };

    const bucketsFor = async (monitorID: number) => R.getAll(
        "SELECT * FROM monitor_metric_hourly WHERE monitor_id = ? ORDER BY time", [ monitorID ]);

    await t.test("one hour folds every monitor, not just the first one seen", async () => {
        // Three monitors in the same four-hour-old window: 08:00 and 11:00.
        for (const monitorID of monitors) {
            await insertRaw(monitorID, hour(0) + 5 * 60_000, 10 + monitorID);
            await insertRaw(monitorID, hour(3) + 5 * 60_000, 20 + monitorID);
        }

        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 6, "two hours for each of three monitors");

        for (const monitorID of monitors) {
            const rows = await bucketsFor(monitorID);
            assert.strictEqual(rows.length, 2, `monitor ${monitorID} has both hours`);
            assert.strictEqual(rows[0].time, sql(hour(0)));
            assert.strictEqual(rows[1].time, sql(hour(3)));
            assert.strictEqual(rows[0].cpu_avg, 10 + monitorID);
        }
    });

    await t.test("a run with no new evidence is a no-op", async () => {
        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 0, "covered pairs are not re-rolled");
        assert.strictEqual(result.chunks, 0, "no raw window is read");
    });

    await t.test("late backfill into an old folded hour is re-folded", async () => {
        // Older than any recency overlap: the count comparison must catch it.
        await insertRaw(monitors[0], hour(0) + 50 * 60_000, 90);
        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 1, "only the affected pair re-rolls");

        const rows = await bucketsFor(monitors[0]);
        assert.strictEqual(rows[0].samples, 2);
        assert.strictEqual(rows[0].cpu_avg, (10 + monitors[0] + 90) / 2);
        assert.strictEqual(rows[0].cpu_max, 90);
        assert.strictEqual((await bucketsFor(monitors[1])).length, 2, "other monitors untouched");
    });

    await t.test("missing buckets are repaired from raw evidence", async () => {
        await R.exec("DELETE FROM monitor_metric_hourly WHERE monitor_id = ? AND time = ?", [ monitors[1], sql(hour(3)) ]);
        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 1, "the deleted bucket is rebuilt");
        assert.strictEqual((await bucketsFor(monitors[1]))[1].samples, 1);
    });

    await t.test("dirty markers force a re-fold even when counts agree, then clear", async () => {
        await markRollupDirty(monitors[2], sql(hour(0) + 10 * 60_000));
        const dirty = await R.getAll("SELECT * FROM monitor_metric_rollup_dirty");
        assert.strictEqual(dirty.length, 1, "ingest-side marker recorded");

        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 1, "the marked hour re-folds");
        assert.strictEqual((await R.getAll("SELECT * FROM monitor_metric_rollup_dirty")).length, 0, "marker consumed");

        const again = await rollupMetrics(now);
        assert.strictEqual(again.rolledUp, 0, "no marker, no re-fold");
    });

    await t.test("markers whose raw rows are gone are dropped, buckets stay", async () => {
        await markRollupDirty(monitors[0], sql(hour(2))); // 09:00 has no raw rows at all
        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 0, "nothing to re-fold without evidence");
        assert.strictEqual((await R.getAll("SELECT * FROM monitor_metric_rollup_dirty")).length, 0, "stale marker dropped");
        assert.strictEqual((await bucketsFor(monitors[0])).length, 2, "existing buckets survive");
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

test("rollup work is bounded in elapsed time and rows", async (t) => {
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
        monitor.name = "Bounded Rollup Host";
        monitor.type = "push";
        monitor.interval = 60;
        monitor.retryInterval = 60;
        monitor.timeout = 48;
        monitor.active = 1;
        await R.store(monitor);
        monitorID = monitor.id;
    });

    t.after(async () => {
        await testDb.destroy();
    });

    const now = Date.parse("2026-10-10T12:30:00Z");
    const lastComplete = Date.parse("2026-10-10T11:00:00Z");
    const payload = (cpu: number) => JSON.stringify({ cpu: { percent: cpu }, mem: { percent: 50 } });

    const rawBean = (time: number, cpu: number) => {
        const bean = R.dispense("monitor_metric");
        bean.monitor_id = monitorID;
        bean.time = sql(time);
        bean.payload = payload(cpu);
        return bean;
    };

    await t.test("a gap splits the chunks instead of stretching one across it", async () => {
        // One hour 20 days back, one recent hour: the old code produced a
        // single chunk whose window spanned the whole gap.
        const oldHour = lastComplete - 20 * 24 * HOUR;
        await R.store(rawBean(oldHour + 5 * 60_000, 10));
        await R.store(rawBean(lastComplete + 5 * 60_000, 20));

        const { rollupMetrics } = require("../../server/metrics-rollup");
        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 2);
        assert.strictEqual(result.chunks, 2, "the 20-day gap must split the two hours into separate chunks");

        const rows = await R.getAll("SELECT time, samples FROM monitor_metric_hourly ORDER BY time");
        assert.strictEqual(rows.length, 2);
    });

    await t.test("a chunk wider than one page is folded page by page", async () => {
        const { rollupMetrics, ROWS_PER_PAGE } = require("../../server/metrics-rollup");
        const hour = Date.parse("2026-10-10T10:00:00Z");
        const total = ROWS_PER_PAGE + 1;

        // One hour with more rows than a single page holds. Insert in small
        // batches: SQLite's compound-SELECT term limit is 500 and knex's
        // union-all insert shape would exceed it at once.
        const beans = [];
        for (let i = 0; i < total; i++) {
            beans.push({ monitor_id: monitorID, time: sql(hour + 1000 + i * 100), payload: payload(i % 100) });
        }
        for (let offset = 0; offset < beans.length; offset += 250) {
            await R.knex("monitor_metric").insert(beans.slice(offset, offset + 250));
        }

        const result = await rollupMetrics(now);
        assert.strictEqual(result.rolledUp, 1);

        const row = await R.getRow(
            "SELECT samples, cpu_min, cpu_max, cpu_avg FROM monitor_metric_hourly WHERE monitor_id = ? AND time = ?",
            [ monitorID, sql(hour) ]);
        assert.strictEqual(row.samples, total, "every page must be folded");
        assert.strictEqual(row.cpu_min, 0);
        assert.strictEqual(row.cpu_max, 99);
        // Values 0..99 repeating: 50 full cycles plus the remainder.
        const cycles = Math.floor(total / 100);
        const remainder = total % 100;
        const expected = (cycles * 4950 + (remainder * (remainder - 1)) / 2) / total;
        assert.ok(Math.abs(row.cpu_avg - expected) < 1e-9, `cpu_avg ${row.cpu_avg} != ${expected}`);
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
