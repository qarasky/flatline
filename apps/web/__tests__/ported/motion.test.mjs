import { test } from "vitest";
import assert from "node:assert/strict";
import {
    IDLE_CALM_MS,
    LIVE_BURST_CAP,
    curve,
    duration,
    enterTransition,
    exitTransition,
    highlightDuration,
    isCalm,
    planCues,
    shouldHoldReorder,
    tooltipShouldAnimate,
} from "@/lib/motion";

test("tokens follow the motion guide", () => {
    assert.deepEqual([duration.fast, duration.base, duration.slow], [0.1, 0.18, 0.24]);
    assert.equal(exitTransition(duration.slow).duration, 0.24 * 0.6);
    assert.equal(enterTransition().duration, 0.18);
    assert.deepEqual(curve.entrance, [0, 0, 0.38, 0.9]);
    assert.deepEqual(curve.exit, [0.2, 0, 1, 0.9]);
});

test("a burst above the cap becomes one group cue, at or below it per-row cues", () => {
    assert.deepEqual(planCues([]), { rows: [], group: false });
    const six = [1, 2, 3, 4, 5, 6];
    assert.equal(LIVE_BURST_CAP, 6);
    assert.deepEqual(planCues(six), { rows: six, group: false });
    assert.deepEqual(planCues([...six, 7]), { rows: [], group: true });
    assert.deepEqual(planCues([1, 2, 3], 2), { rows: [], group: true });
});

test("reorder is held under the pointer, with a selection or an open menu", () => {
    const base = { pointerOverList: false, selectionSize: 0, menuOpen: false };
    assert.equal(shouldHoldReorder(base), false);
    assert.equal(shouldHoldReorder({ ...base, pointerOverList: true }), true);
    assert.equal(shouldHoldReorder({ ...base, selectionSize: 2 }), true);
    assert.equal(shouldHoldReorder({ ...base, menuOpen: true }), true);
});

test("calm mode starts after five minutes without input and drops highlights", () => {
    assert.equal(IDLE_CALM_MS, 300000);
    assert.equal(isCalm(0, IDLE_CALM_MS - 1), false);
    assert.equal(isCalm(0, IDLE_CALM_MS), true);
    assert.equal(highlightDuration(true), 0);
    assert.ok(highlightDuration(false) > 0 && highlightDuration(false) < 1);
});

test("a tooltip skips its enter animation when another is open", () => {
    assert.equal(tooltipShouldAnimate(0), true);
    assert.equal(tooltipShouldAnimate(1), false);
});
