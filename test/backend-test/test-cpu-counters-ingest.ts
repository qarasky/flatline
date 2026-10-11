/**
 * Integration tests for server-side CPU derivation from raw counters.
 *
 * Agents push cumulative snapshots (`cpu.counters`); the server diffs them.
 * Live/latest uses the short window since the previous push (responsive),
 * archived rows use the long window since the previous persist (honest
 * 30-second means). Anything incomputable keeps the agent's compat fields.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB("./data/test-counters");

// Two cores with even splits so every assertion is exact.
const snap = (total: number, idle: number) => ({
    total,
    idle,
    perCore: [
        { total: total / 2, idle: idle / 2 - 0.5 },
        { total: total / 2, idle: idle / 2 + 0.5 },
    ],
});
const A = snap(100000, 90000);
const SPIKE = snap(100100, 90005); // +100/+5 over A: a 95% single second
const B = snap(103000, 92905); // +3000/+2905 over A: a 3.17% thirty seconds

const cpuPayload = (percent: number, counters: any) => ({
    v: 1,
    cpu: { percent, cores: 2, perCore: [percent, percent], counters },
});

test("server derives CPU from raw counters; history keeps interval means", async (t) => {
    const ids: number[] = [];
    t.before(async () => {
        await testDb.create();
        // @ts-ignore
        const { auth } = require("../../server/better-auth");
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
        const { R } = require("redbean-node");
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        for (let i = 0; i < 4; i++) {
            const bean = R.dispense("monitor");
            bean.user_id = owner.id;
            bean.name = `Counter Host ${i}`;
            bean.type = "push";
            bean.interval = 60;
            bean.retryInterval = 60;
            bean.timeout = 48;
            bean.active = 1;
            bean.push_token = `test-counter-token-${i}`;
            await R.store(bean);
            ids.push(bean.id);
        }
        const { resetMetricsCache } = require("../../server/monitor-metrics");
        const { resetCPU } = require("../../server/cpu-peak");
        resetMetricsCache();
        resetCPU();
    });
    t.after(async () => {
        await testDb.destroy();
    });

    const rows = async (id: number) => {
        const { R } = require("redbean-node");
        return await R.getAll("SELECT * FROM monitor_metric WHERE monitor_id = ? ORDER BY id", [id]);
    };

    await t.test("legacy pushes persist derived windows, first sight keeps agent values", async () => {
        const { storeMetrics } = require("../../server/monitor-metrics");
        assert.strictEqual(await storeMetrics(ids[0], "2026-10-11T00:00:00Z", cpuPayload(50, A)), true);
        assert.strictEqual(await storeMetrics(ids[0], "2026-10-11T00:05:00Z", cpuPayload(50, B)), true);
        const all = await rows(ids[0]);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(JSON.parse(all[0].payload).cpu.percent, 50);
        const second = JSON.parse(all[1].payload).cpu;
        assert.ok(Math.abs(second.percent - 3.17) < 0.005, `archive mean = ${second.percent}, want ~3.17`);
        assert.ok(Math.abs(second.perCore[0] - 3.2) < 0.05, `per-core = ${second.perCore}`);
        assert.strictEqual(second.cores, 2);
        // Raw snapshots travel with the row for audit and recompute.
        assert.strictEqual(JSON.parse(all[1].payload).cpu.counters.total, 103000);
    });

    await t.test("percent-only payloads pass through untouched", async () => {
        const { storeMetrics, getLatestMetrics } = require("../../server/monitor-metrics");
        assert.strictEqual(await storeMetrics(ids[1], "2026-10-11T00:00:00Z", { v: 1, cpu: { percent: 42 } }), true);
        assert.strictEqual(await storeMetrics(ids[1], "2026-10-11T00:01:00Z", { v: 1, cpu: { percent: 43 } }), true);
        const all = await rows(ids[1]);
        assert.strictEqual(JSON.parse(all[1].payload).cpu.percent, 43);
        assert.strictEqual(getLatestMetrics(ids[1]).metrics.cpu.percent, 43);
    });

    await t.test("live latest stays responsive while archived rows average; out-of-order never rewinds", async (st) => {
        const { storeMetrics, getLatestMetrics } = require("../../server/monitor-metrics");
        let fakeNow = 1_760_000_000_000;
        st.mock.method(Date, "now", () => fakeNow);

        // First sight: no predecessor, agent values stand, state initializes.
        assert.strictEqual(
            await storeMetrics(ids[2], "2026-10-11T00:00:00Z", cpuPayload(99, A), { live: true }), true);
        assert.strictEqual((await rows(ids[2])).length, 1);
        assert.strictEqual(getLatestMetrics(ids[2]).metrics.cpu.percent, 99);

        // One second later the box spikes: latest follows (live), nothing archives.
        assert.strictEqual(
            await storeMetrics(ids[2], "2026-10-11T00:00:01Z", cpuPayload(95, SPIKE), { live: true }), true);
        assert.strictEqual((await rows(ids[2])).length, 1);
        const live = getLatestMetrics(ids[2]).metrics.cpu.percent;
        assert.ok(Math.abs(live - 95) < 0.005, `live = ${live}, want ~95`);

        // Thirty-one seconds on the box goes idle. The archived row must be
        // the ~30s mean (~3.17), not the 95 the agent pushed mid-window.
        fakeNow += 31_000;
        assert.strictEqual(
            await storeMetrics(ids[2], "2026-10-11T00:00:32Z", cpuPayload(95, B), { live: true }), true);
        const all = await rows(ids[2]);
        assert.strictEqual(all.length, 2);
        const archived = JSON.parse(all[1].payload).cpu.percent;
        assert.ok(Math.abs(archived - 3.17) < 0.005, `archived = ${archived}, want ~3.17, never the 95 spike`);
        // The final second was idle, so live reads ~0 while history reads 3.17.
        assert.ok(Math.abs(getLatestMetrics(ids[2]).metrics.cpu.percent - 0) < 0.005);
    });

    await t.test("stale arrivals keep agent values and leave the windows alone", async () => {
        const { storeMetrics } = require("../../server/monitor-metrics");
        const C = snap(106000, 95305); // +3000/+2400 over B: 20%
        assert.strictEqual(await storeMetrics(ids[3], "2026-10-11T00:00:00Z", cpuPayload(50, A)), true);
        assert.strictEqual(await storeMetrics(ids[3], "2026-10-11T00:05:00Z", cpuPayload(50, B)), true);
        assert.strictEqual(await storeMetrics(ids[3], "2026-10-11T00:02:00Z", cpuPayload(80, A)), true);
        assert.strictEqual(await storeMetrics(ids[3], "2026-10-11T00:10:00Z", cpuPayload(80, C)), true);
        const all = await rows(ids[3]);
        assert.strictEqual(all.length, 4);
        assert.strictEqual(JSON.parse(all[2].payload).cpu.percent, 80);
        const fourth = JSON.parse(all[3].payload).cpu.percent;
        assert.ok(Math.abs(fourth - 20) < 0.005, `post-stale window = ${fourth}, want 20 (delta vs B, not rewound to A)`);
    });
});
