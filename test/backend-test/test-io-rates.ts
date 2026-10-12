/**
 * Network / disk I/O rate derivation (backlog 3.1).
 *
 * Pure unit tests for the rate math plus an ingest test proving that
 * consecutive pushes attach netRate/diskIoRate to the live sample and that
 * gaps and resets omit them instead of inventing numbers.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB("./data/test-io-rates");

const netPayload = (entries: [string, number, number][]) => ({
    net: entries.map(([ iface, rxBytes, txBytes ]) => ({ iface, rxBytes, txBytes })),
});
const ioPayload = (entries: [string, number, number][]) => ({
    diskIo: entries.map(([ device, readBytes, writeBytes ]) => ({ device, readBytes, writeBytes })),
});

test("io rate derivation", async (t) => {
    const { netSnapshot, diskSnapshot, netRates, diskRates, MAX_WINDOW_MS } = require("../../server/io-rates");

    await t.test("snapshots reject garbage and keep valid entries", async () => {
        assert.strictEqual(netSnapshot({}), null);
        assert.strictEqual(netSnapshot({ net: "nope" }), null);
        assert.strictEqual(netSnapshot({ net: [ { iface: "", rxBytes: 1, txBytes: 1 } ] }), null);
        assert.strictEqual(netSnapshot({ net: [ { iface: "eth0", rxBytes: -1, txBytes: 0 } ] }), null);
        const map = netSnapshot(netPayload([ [ "eth0", 100, 50 ], [ "eth1", 10, 5 ] ]));
        assert.strictEqual(map.size, 2);
        assert.deepStrictEqual(map.get("eth0"), { rx: 100, tx: 50 });

        assert.strictEqual(diskSnapshot({ diskIo: [ { device: "sda", readBytes: NaN, writeBytes: 1 } ] }), null);
        assert.strictEqual(diskSnapshot(ioPayload([ [ "sda", 10, 20 ] ])).get("sda").write, 20);
    });

    await t.test("rates are deltas over the window, summed across interfaces", async () => {
        const prev = netSnapshot(netPayload([ [ "eth0", 1000, 500 ] ]));
        const cur = netSnapshot(netPayload([ [ "eth0", 3000, 1500 ] ]));
        const rate = netRates(prev, cur, 10_000);
        assert.strictEqual(rate.rxBytesPerSec, 200);
        assert.strictEqual(rate.txBytesPerSec, 100);
        assert.strictEqual(rate.windowSeconds, 10);
    });

    await t.test("virtual interfaces are excluded so container traffic is not double counted", async () => {
        const prev = netSnapshot(netPayload([ [ "eth0", 0, 0 ], [ "veth1234", 0, 0 ], [ "docker0", 0, 0 ] ]));
        const cur = netSnapshot(netPayload([ [ "eth0", 1000, 0 ], [ "veth1234", 800, 0 ], [ "docker0", 700, 0 ] ]));
        const rate = netRates(prev, cur, 1000);
        assert.strictEqual(rate.rxBytesPerSec, 1000, "only the physical interface counts");
    });

    await t.test("a host with only virtual interfaces falls back to summing them", async () => {
        const prev = netSnapshot(netPayload([ [ "veth1", 0, 0 ] ]));
        const cur = netSnapshot(netPayload([ [ "veth1", 500, 0 ] ]));
        assert.strictEqual(netRates(prev, cur, 1000).rxBytesPerSec, 500);
    });

    await t.test("resets, gaps and missing data yield null, never fake numbers", async () => {
        const prev = netSnapshot(netPayload([ [ "eth0", 5000, 0 ] ]));
        const reset = netSnapshot(netPayload([ [ "eth0", 10, 0 ] ]));
        assert.strictEqual(netRates(prev, reset, 1000), null, "counter reset");
        assert.strictEqual(netRates(prev, prev, 0), null, "zero window");
        assert.strictEqual(netRates(prev, prev, -5), null, "negative window");
        assert.strictEqual(netRates(prev, prev, MAX_WINDOW_MS + 1), null, "gap longer than the window");
        assert.strictEqual(netRates(null, prev, 1000), null);
        assert.strictEqual(netRates(prev, null, 1000), null);

        // A new interface appearing mid-window has no delta; existing ones still count.
        const before = netSnapshot(netPayload([ [ "eth0", 0, 0 ] ]));
        const after = netSnapshot(netPayload([ [ "eth0", 100, 0 ], [ "eth1", 999, 999 ] ]));
        assert.strictEqual(netRates(before, after, 1000).rxBytesPerSec, 100);

        const ioPrev = diskSnapshot(ioPayload([ [ "sda", 0, 0 ] ]));
        const ioReset = diskSnapshot(ioPayload([ [ "sda", 0, 0 ] ]));
        assert.strictEqual(diskRates(ioPrev, ioReset, 1000).readBytesPerSec, 0, "zero delta is a real rate");
        assert.strictEqual(diskRates(ioPrev, diskSnapshot(ioPayload([ [ "sda", -1, 0 ] ])), 1000), null);
    });
});

test("ingest attaches live I/O rates across consecutive pushes", async (t) => {
    const { R } = require("redbean-node");
    let monitorID = 0;

    t.before(async () => {
        await testDb.create();
        const { resetMetricsCache, resetMetricAlerts } = (() => ({
            resetMetricsCache: require("../../server/monitor-metrics").resetMetricsCache,
            resetMetricAlerts: require("../../server/metric-alerts").resetMetricAlerts,
        }))();
        resetMetricsCache();
        resetMetricAlerts();

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
        monitor.name = "IO Host";
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

    await t.test("first push has no rate; second derives over its window", async () => {
        const { storeMetrics, getLatestMetrics } = require("../../server/monitor-metrics");

        const first = { v: 1, ...netPayload([ [ "eth0", 0, 0 ] ]), ...ioPayload([ [ "sda", 0, 0 ] ]) };
        await storeMetrics(monitorID, "2026-10-12T10:00:00Z", first, { live: true });
        const one = getLatestMetrics(monitorID);
        assert.strictEqual(one.metrics.netRate, undefined, "no previous snapshot, no rate");
        assert.strictEqual(one.metrics.diskIoRate, undefined);
        assert.deepStrictEqual(one.metrics.net, first.net, "raw counters survive in the sample");

        const second = { v: 1, ...netPayload([ [ "eth0", 20_000, 10_000 ] ]), ...ioPayload([ [ "sda", 4_000, 2_000 ] ]) };
        await storeMetrics(monitorID, "2026-10-12T10:00:10Z", second, { live: true });
        const two = getLatestMetrics(monitorID);
        assert.strictEqual(two.metrics.netRate.rxBytesPerSec, 2000);
        assert.strictEqual(two.metrics.netRate.txBytesPerSec, 1000);
        assert.strictEqual(two.metrics.netRate.windowSeconds, 10);
        assert.strictEqual(two.metrics.diskIoRate.readBytesPerSec, 400);
        assert.strictEqual(two.metrics.diskIoRate.writeBytesPerSec, 200);
    });

    await t.test("a gap longer than the window omits the rate", async () => {
        const { storeMetrics, getLatestMetrics } = require("../../server/monitor-metrics");
        const later = { v: 1, ...netPayload([ [ "eth0", 40_000, 10_000 ] ]) };
        await storeMetrics(monitorID, "2026-10-12T11:00:00Z", later, { live: true });
        const sample = getLatestMetrics(monitorID);
        assert.strictEqual(sample.metrics.netRate, undefined, "an hour-long gap must not become a rate");
        // The state still advanced, so the next close sample derives again.
        const next = { v: 1, ...netPayload([ [ "eth0", 42_000, 10_000 ] ]) };
        await storeMetrics(monitorID, "2026-10-12T11:00:10Z", next, { live: true });
        assert.strictEqual(getLatestMetrics(monitorID).metrics.netRate.rxBytesPerSec, 200);
    });
});
