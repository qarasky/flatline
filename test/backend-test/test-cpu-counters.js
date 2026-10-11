const { test } = require("node:test");
const assert = require("node:assert/strict");
const { asCounters, utilization, perCoreUtilization, transformCounters } = require("../../server/cpu-counters");

test("asCounters accepts well-formed snapshots and rejects everything else", () => {
    const good = asCounters({ percent: 3.2, counters: { total: 103000, idle: 92905, perCore: [{ total: 1, idle: 0 }] } });
    assert.deepEqual(good, { total: 103000, idle: 92905, perCore: [{ total: 1, idle: 0 }] });
    assert.equal(asCounters({ percent: 3.2 }), null);
    assert.equal(asCounters(null), null);
    assert.equal(asCounters({ counters: { total: -1, idle: 0 } }), null);
    assert.equal(asCounters({ counters: { total: 1 } }), null);
    assert.equal(asCounters({ counters: { total: 1, idle: 0, perCore: [{ total: 1 }] } }), null);
    assert.equal(asCounters({ counters: { total: 1, idle: 0, perCore: "x" } }), null);
    assert.equal(asCounters({ counters: [1, 2] }), null);
});

test("utilization is busy-over-total across the window, null when the window says nothing", () => {
    // 30s of mostly-idle time with a 1s 95% spike inside: ~3.17%, not 95.
    assert.ok(Math.abs(utilization({ total: 100000, idle: 90000 }, { total: 103000, idle: 92905 }) - 3.17) < 0.01);
    assert.equal(utilization({ total: 0, idle: 0 }, { total: 1000, idle: 0 }), 100);
    assert.equal(utilization({ total: 0, idle: 0 }, { total: 1000, idle: 1000 }), 0);
    assert.equal(utilization({ total: 100, idle: 50 }, { total: 100, idle: 50 }), null);
    assert.equal(utilization({ total: 200, idle: 100 }, { total: 100, idle: 50 }), null);
    assert.equal(utilization({ total: 100, idle: 90 }, { total: 200, idle: 50 }), null);
    assert.equal(utilization({ total: 100, idle: 50 }, { total: 200, idle: 180 }), null);
    assert.equal(utilization(null, { total: 1, idle: 0 }), null);
});

test("per-core needs matching shapes; hotplug yields null until the next pair", () => {
    const a = [{ total: 100, idle: 80 }, { total: 100, idle: 60 }];
    const b = [{ total: 200, idle: 130 }, { total: 200, idle: 110 }];
    assert.deepEqual(perCoreUtilization(a, b), [50, 50]);
    assert.equal(perCoreUtilization(a, [...b, { total: 1, idle: 0 }]), null);
});

test("transformCounters needs a predecessor and a computable window", () => {
    assert.equal(transformCounters(null, { total: 1, idle: 0, perCore: [] }), null);
    const t = transformCounters(
        { total: 100000, idle: 90000, perCore: [{ total: 50000, idle: 45000 }] },
        { total: 103000, idle: 92905, perCore: [{ total: 51500, idle: 46455 }] });
    assert.ok(Math.abs(t.percent - 3.17) < 0.01);
    assert.equal(t.perCore.length, 1);
    assert.equal(t.cores, 1);
    const empty = transformCounters({ total: 1, idle: 1, perCore: [] }, { total: 2, idle: 1, perCore: [] });
    assert.equal(empty.percent, 100);
    assert.equal(empty.perCore, null);
});
