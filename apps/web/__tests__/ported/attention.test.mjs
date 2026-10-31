import { test } from "vitest";
import assert from "node:assert/strict";
import { attentionMonitorIds, deriveAttention, formatDuration, unmutedCount } from "@/lib/attention";
import { stripsFromResponse, windowStart } from "@/lib/heartbeat-strip";

const NOW = Date.parse("2026-10-21T10:47:00Z");
const BM = 1800_000;
const START = windowStart(NOW, BM, 48);
const iso = (ms) => new Date(ms).toISOString();

const mon = (id, extra = {}) => ({
    id,
    name: `m${id}`,
    type: "http",
    status: 1,
    active: true,
    interval: 60,
    lastCheck: iso(NOW - 10_000),
    lastMessage: null,
    ...extra,
});
const stripsFor = (cells) =>
    stripsFromResponse({
        bucketSeconds: 1800,
        buckets: 48,
        start: iso(START),
        strips: Object.fromEntries(
            Object.entries(cells).map(([id, c]) => [id, Array.from({ length: 48 }, (_, i) => c[i] ?? null)])
        ),
    });

test("durations read compactly", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(12 * 60_000), "12m");
    assert.equal(formatDuration(130 * 60_000), "2h 10m");
    assert.equal(formatDuration(24 * 3600_000), "1d");
    assert.equal(formatDuration(28 * 3600_000), "1d 4h");
});

test("healthy fleet has nothing to report", () => {
    assert.deepEqual(deriveAttention({ monitors: [mon(1), mon(2)], strips: new Map(), nowMs: NOW }), []);
});

test("down and pending are listed worst first with how long", () => {
    const strips = stripsFor({ 2: { 45: [0, 5, 5], 46: [0, 5, 5], 47: [0, 2, 2] } });
    const items = deriveAttention({
        monitors: [mon(1, { status: 2 }), mon(2, { status: 0 }), mon(3, { status: 0, active: false })],
        strips,
        nowMs: NOW,
    });
    assert.deepEqual(
        items.map((i) => [i.kind, i.monitorId]),
        [
            ["down", 2],
            ["pending", 1],
        ]
    );
    assert.equal(
        items[0].detail,
        `for ${Math.floor((NOW - (START + 45 * BM)) / 60000 / 60)}h ${Math.floor(((NOW - (START + 45 * BM)) / 60000) % 60)}m`
    );
    assert.equal(items[1].detail, "checking again"); // no strip, no live flip
});

test("a live flip time beats bucket resolution", () => {
    const items = deriveAttention({
        monitors: [mon(1, { status: 0 })],
        strips: new Map(),
        nowMs: NOW,
        changedAt: new Map([[1, NOW - 120_000]]),
    });
    assert.equal(items[0].detail, "for 2m");
});

test("flapping needs four changes in six hours and yields to down", () => {
    const flap = { 40: [1, 1, 0], 41: [0, 1, 1], 43: [1, 1, 0], 44: [0, 1, 1], 46: [1, 1, 0] };
    const strips = stripsFor({ 1: flap, 2: flap });
    const items = deriveAttention({ monitors: [mon(1), mon(2, { status: 0 })], strips, nowMs: NOW });
    assert.deepEqual(
        items.map((i) => [i.kind, i.monitorId]),
        [
            ["down", 2],
            ["flapping", 1],
        ]
    );
});

test("stale push: no beat for more than three intervals; other types and recent beats are fine", () => {
    const monitors = [
        mon(1, { type: "push", interval: 60, lastCheck: iso(NOW - 181_000) }),
        mon(2, { type: "push", interval: 60, lastCheck: iso(NOW - 179_000) }),
        mon(3, { type: "http", interval: 60, lastCheck: iso(NOW - 3600_000) }),
    ];
    const items = deriveAttention({ monitors, strips: new Map(), nowMs: NOW });
    assert.deepEqual(
        items.map((i) => [i.kind, i.monitorId]),
        [["stale", 1]]
    );
});

test("agent warnings and failed or overdue backups are included", () => {
    const items = deriveAttention({
        monitors: [mon(1), mon(2, { active: false })],
        strips: new Map(),
        nowMs: NOW,
        agentWarnings: new Map([
            [1, "Agent: 3 push failures"],
            [2, "Agent: ignored, paused"],
        ]),
        backups: [
            { id: "a", name: "db", monitorId: 1, enabled: true, health: "overdue", lastErrorCode: null },
            { id: "b", name: "files", monitorId: null, enabled: true, health: "failed", lastErrorCode: "disk_full" },
            { id: "c", name: "ok", monitorId: 1, enabled: true, health: "healthy", lastErrorCode: null },
            { id: "d", name: "off", monitorId: 1, enabled: false, health: "failed", lastErrorCode: null },
        ],
    });
    assert.deepEqual(
        items.map((i) => i.kind),
        ["agent", "backup", "backup"]
    );
    assert.equal(items[0].detail, "3 push failures");
    assert.deepEqual([...attentionMonitorIds(items)], [1]);
});

test("muted items sort last and are not counted", () => {
    const items = deriveAttention({
        monitors: [mon(1, { status: 0, mutedBy: [9] }), mon(2, { status: 2 })],
        strips: new Map(),
        nowMs: NOW,
    });
    assert.deepEqual(
        items.map((i) => [i.kind, i.monitorId, i.muted]),
        [
            ["pending", 2, false],
            ["down", 1, true],
        ]
    );
    assert.equal(unmutedCount(items), 1);
});

test("a muted host's stale and backup items are muted too", () => {
    const items = deriveAttention({
        monitors: [mon(1, { type: "push", status: 1, mutedBy: [1], lastCheck: iso(NOW - 3600_000) })],
        strips: new Map(),
        nowMs: NOW,
        backups: [{ id: "b", name: "bk", monitorId: 1, enabled: true, health: "overdue" }],
    });
    assert.deepEqual(
        items.map((i) => [i.kind, i.muted]),
        [
            ["stale", true],
            ["backup", true],
        ]
    );
});
