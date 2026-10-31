import { test } from "vitest";
import assert from "node:assert/strict";
import { cardMute, coveredIds, isCovered } from "@/lib/mute";

const host = (extra = {}) => ({ id: 1, name: "srv", type: "push", status: 0, mutedBy: [1], ...extra });

test("card with every down monitor covered is muted", () => {
    const monitor = host({ mute: { mutedAt: "2026-10-26 10:00:00.000", monitors: [1, 7], hostMuted: true } });
    const mute = cardMute(monitor, [{ id: 7, status: 0 }], new Set([1, 7]));
    assert.deepEqual(mute, { muted: true, hostMuted: true, since: "2026-10-26 10:00:00.000", coveredDown: [1, 7] });
});

test("one uncovered down link unmutes the card", () => {
    const mute = cardMute(
        host(),
        [
            { id: 7, status: 0 },
            { id: 8, status: 0 },
        ],
        new Set([1, 7])
    );
    assert.equal(mute.muted, false);
});

test("a website-only mute leaves the host unmuted", () => {
    const mute = cardMute(host({ status: 1, mutedBy: [] }), [{ id: 7, status: 0 }], new Set([7]));
    assert.equal(mute.muted, true);
    assert.equal(mute.hostMuted, false);
    assert.deepEqual(mute.coveredDown, [7]);
});

test("a healthy card is not muted", () => {
    const mute = cardMute(host({ status: 1 }), [{ id: 7, status: 1 }], new Set([1, 7]));
    assert.equal(mute.muted, false);
});

test("missing fields mean not muted", () => {
    const old = { id: 1, name: "srv", type: "push", status: 0 };
    assert.equal(isCovered(old), false);
    assert.equal(isCovered(undefined), false);
    assert.equal(coveredIds([old]).size, 0);
    assert.equal(cardMute(old, [{ id: 7, status: 0 }], coveredIds([old])).muted, false);
});

test("coveredIds lists monitors with a covering subject", () => {
    assert.deepEqual([...coveredIds([host(), { id: 2, status: 0, mutedBy: [] }, { id: 3, mutedBy: [1] }])], [1, 3]);
});
