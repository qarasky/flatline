import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { EventBatcher, applyPatches, changedStatusIds, coalesceBeats } from "@/lib/live-batch";

const monitor = (id, status = 1) => ({ id, name: `m${id}`, type: "http", status, active: true });

test("events inside one window flush once", () => {
    vi.useFakeTimers();
    try {
        const flushes = [];
        const batcher = new EventBatcher(250, (items) => flushes.push(items));
        batcher.push(1);
        batcher.push(2);
        vi.advanceTimersByTime(249);
        assert.equal(flushes.length, 0);
        vi.advanceTimersByTime(1);
        assert.deepEqual(flushes, [[1, 2]]);
        batcher.push(3);
        vi.advanceTimersByTime(250);
        assert.deepEqual(flushes, [[1, 2], [3]]);
    } finally {
        vi.useRealTimers();
    }
});

test("paused batcher buffers and applies everything on resume; clear drops it", () => {
    vi.useFakeTimers();
    try {
        const flushes = [];
        const batcher = new EventBatcher(250, (items) => flushes.push(items));
        batcher.pause();
        batcher.push("a");
        batcher.push("b");
        vi.advanceTimersByTime(5000);
        assert.equal(flushes.length, 0);
        assert.equal(batcher.size, 2);
        batcher.resume();
        assert.deepEqual(flushes, [["a", "b"]]);
        batcher.pause();
        batcher.push("c");
        batcher.clear();
        batcher.resume();
        assert.equal(flushes.length, 1);
    } finally {
        vi.useRealTimers();
    }
});

test("the queue is bounded", () => {
    const batcher = new EventBatcher(250, () => {}, 3);
    batcher.pause();
    for (let i = 0; i < 10; i++) {
        batcher.push(i);
    }
    assert.equal(batcher.size, 3);
    batcher.dispose();
});

test("coalescing keeps the last patch per monitor and every beat in order", () => {
    const { patches, beats } = coalesceBeats([
        { monitorId: 1, patch: { status: 0, ping: 10 } },
        { monitorId: 2, patch: { status: 1 } },
        { monitorId: 1, patch: { status: 1, lastCheck: "t" } },
    ]);
    assert.deepEqual(patches.get(1), { status: 1, ping: 10, lastCheck: "t" });
    assert.equal(beats.length, 3);
});

test("applying patches preserves identity of untouched monitors and detects status changes", () => {
    const before = [monitor(1), monitor(2), monitor(3)];
    const same = applyPatches(before, new Map([[99, { status: 0 }]]));
    assert.equal(same, before);
    const after = applyPatches(
        before,
        new Map([
            [1, { status: 0 }],
            [2, { ping: 12 }],
        ])
    );
    assert.equal(after[2], before[2]);
    assert.deepEqual(changedStatusIds(before, after), [1]);
});
