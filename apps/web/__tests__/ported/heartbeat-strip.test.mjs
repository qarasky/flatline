import { test } from "vitest";
import assert from "node:assert/strict";
import {
    alignStrip,
    bucketInfo,
    chunkIds,
    isFlapping,
    lastChangeMs,
    placeBeat,
    statusChangesWithin,
    statusSince,
    stripsFromResponse,
    windowStart,
    worstStatus,
} from "@/lib/heartbeat-strip";

const BS = 1800;
const BM = BS * 1000;
// 2026-10-21T10:47:00Z, mid-bucket
const NOW = Date.parse("2026-10-21T10:47:00Z");
const START = windowStart(NOW, BM, 48);

function fixture(cells = {}) {
    const row = Array.from({ length: 48 }, (_, i) => cells[i] ?? null);
    return stripsFromResponse({
        ok: true,
        hours: 24,
        buckets: 48,
        bucketSeconds: BS,
        start: new Date(START).toISOString(),
        strips: { 7: row },
    }).get(7);
}

test("window start is epoch aligned and ends in the bucket containing now", () => {
    assert.equal(START % BM, 0);
    assert.equal(new Date(START).toISOString(), "2026-10-20T11:00:00.000Z");
    assert.ok(START + 47 * BM <= NOW && NOW < START + 48 * BM);
});

test("response parsing pads, trims and drops malformed strips", () => {
    const map = stripsFromResponse({
        bucketSeconds: BS,
        buckets: 4,
        start: "2026-10-21T10:00:00.000Z",
        strips: { 1: [[1, 10, 0], null], 2: "nope", x: [], 3: [[1, 1, 0], ["a"], [0, 2, 2], null, [1, 1, 0]] },
    });
    assert.deepEqual([...map.keys()], [1, 3]);
    assert.equal(map.get(1).cells.length, 4);
    assert.equal(map.get(3).cells[1], null);
    assert.deepEqual(map.get(3).cells[2], [0, 2, 2]);
    assert.equal(map.get(3).cells.length, 4);
    assert.equal(stripsFromResponse({}).size, 0);
});

test("worst-of merge ranks down > pending > maintenance > up", () => {
    assert.equal(worstStatus(1, 0), 0);
    assert.equal(worstStatus(0, 1), 0);
    assert.equal(worstStatus(1, 2), 2);
    assert.equal(worstStatus(2, 3), 2);
    assert.equal(worstStatus(3, 1), 3);
    assert.equal(worstStatus(1, 9), 1);
});

test("a live beat lands in the newest bucket and merges worst-of", () => {
    let strip = fixture({ 47: [1, 10, 0] });
    strip = placeBeat(strip, NOW - 5000, 1, NOW);
    assert.deepEqual(strip.cells[47], [1, 11, 0]);
    assert.equal(strip.fresh, 0);
    strip = placeBeat(strip, NOW - 1000, 0, NOW);
    assert.deepEqual(strip.cells[47], [0, 12, 1]);
    assert.equal(strip.fresh, 1);
    // an up beat after a down one keeps the bucket down
    strip = placeBeat(strip, NOW, 1, NOW);
    assert.deepEqual(strip.cells[47], [0, 13, 1]);
    assert.equal(strip.fresh, 1);
});

test("an older beat goes to its own bucket; beats before the window are ignored", () => {
    const strip = fixture();
    const placed = placeBeat(strip, START + 3 * BM + 10, 2, NOW);
    assert.deepEqual(placed.cells[3], [2, 1, 0]);
    assert.equal(placed.fresh, 0);
    const old = placeBeat(strip, START - 1000, 0, NOW);
    assert.deepEqual(old.cells, strip.cells);
});

test("the window slides when a new bucket has begun", () => {
    const strip = fixture({ 0: [0, 5, 5], 1: [1, 5, 0], 47: [1, 9, 0] });
    const later = NOW + BM; // next bucket
    const placed = placeBeat(strip, later, 1, later);
    assert.equal(placed.startMs, START + BM);
    assert.deepEqual(placed.cells[0], [1, 5, 0]);
    assert.deepEqual(placed.cells[46], [1, 9, 0]);
    assert.deepEqual(placed.cells[47], [1, 1, 0]);
    assert.equal(placed.fresh, 1); // a new bucket appeared
    const far = alignStrip(strip, NOW + 100 * BM);
    assert.ok(far.cells.every((c) => c === null));
});

test("status changes, flapping and run length", () => {
    const flappy = fixture({
        40: [1, 1, 0],
        41: [0, 1, 1],
        43: [1, 1, 0],
        44: [0, 1, 1],
        46: [1, 1, 0],
        47: [0, 1, 1],
    });
    assert.equal(statusChangesWithin(flappy), 5);
    assert.equal(isFlapping(flappy), true);
    // changes before the 6 h window do not count
    const old = fixture({ 10: [1, 1, 0], 11: [0, 1, 1], 12: [1, 1, 0], 13: [0, 1, 1], 14: [1, 1, 0], 47: [1, 1, 0] });
    assert.equal(isFlapping(old), false);
    assert.equal(isFlapping(undefined), false);

    const down = fixture({ 43: [1, 5, 0], 44: [0, 5, 5], 45: [0, 5, 5], 47: [0, 2, 2] });
    // newest data is down; null at 46 breaks the run
    assert.deepEqual(statusSince(down, 0), { sinceMs: START + 47 * BM, atLeast: false });
    const contiguous = fixture({ 44: [0, 5, 5], 45: [0, 5, 5], 46: [0, 5, 5], 47: [0, 2, 2] });
    assert.deepEqual(statusSince(contiguous, 0), { sinceMs: START + 44 * BM, atLeast: false });
    assert.equal(statusSince(contiguous, 1), null);
    const all = fixture(Object.fromEntries(Array.from({ length: 48 }, (_, i) => [i, [0, 1, 1]])));
    assert.deepEqual(statusSince(all, 0), { sinceMs: START, atLeast: true });
    assert.equal(lastChangeMs(down), START + 44 * BM);
    assert.equal(lastChangeMs(all), null);
    assert.equal(lastChangeMs(undefined), null);
});

test("bucket info and id chunking", () => {
    const strip = fixture({ 5: [0, 90, 61] });
    const info = bucketInfo(strip, 5);
    assert.equal(info.status, 0);
    assert.equal(info.beats, 90);
    assert.equal(info.failed, 61);
    assert.equal(info.toMs - info.fromMs, BM);
    assert.equal(bucketInfo(strip, 6).status, null);
    assert.equal(bucketInfo(strip, 99), null);
    const chunks = chunkIds(Array.from({ length: 450 }, (_, i) => i));
    assert.deepEqual(
        chunks.map((c) => c.length),
        [200, 200, 50]
    );
    assert.deepEqual(chunkIds([]), []);
});
