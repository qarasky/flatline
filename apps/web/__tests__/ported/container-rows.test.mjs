import { test } from "vitest";
import assert from "node:assert/strict";
import { containerRows, containerStopped, containerTone } from "@/lib/fleet-presentation";

test("container colors distinguish known failures, transitions, running and unknown stop intent", () => {
    assert.equal(containerTone({ state: "exited" }), "stopped");
    assert.equal(containerTone({ state: "running" }), "up");
    assert.equal(containerTone({ state: "running", health: "healthy" }), "up");
    assert.equal(containerTone({ state: "running", health: "unhealthy" }), "bad");
    for (const state of ["dead", "restarting"]) {
        assert.equal(containerTone({ state }), "bad");
    }
    for (const state of ["created", "paused", "unknown"]) {
        assert.equal(containerTone({ state }), "pending");
    }
    assert.equal(containerTone({ state: "running", health: "starting" }), "pending");
});

test("only exited and removed count as deliberately stopped", () => {
    assert.equal(containerStopped({ state: "exited" }), true);
    assert.equal(containerStopped({ state: "removed" }), true);
    for (const state of ["running", "restarting", "dead", "created", "paused"]) {
        assert.equal(containerStopped({ state }), false);
    }
});

test("cards show at most two rows, failures first, stopped never", () => {
    const containers = [
        { name: "stopped-one", state: "exited" },
        { name: "ok-a", state: "running", stats: { cpuPercent: 10 } },
        { name: "bad-b", state: "running", health: "unhealthy" },
        { name: "ok-c", state: "running", stats: { cpuPercent: 90 } },
        { name: "bad-d", state: "restarting" },
        { name: "bad-e", state: "dead" },
    ];
    const rows = containerRows(containers);
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((c) => c.name),
        ["bad-b", "bad-d"]
    );
    assert.ok(rows.every((c) => c.state !== "exited"));
});

test("an all-healthy card falls back to the busiest running containers", () => {
    const containers = [
        { name: "idle", state: "running", stats: { cpuPercent: 1, memUsed: 10 } },
        { name: "hot", state: "running", stats: { cpuPercent: 300, memUsed: 100 } },
        { name: "warm", state: "running", stats: { cpuPercent: 40, memUsed: 5 } },
        { name: "nope", state: "exited" },
        { name: "created", state: "created" },
    ];
    assert.deepEqual(
        containerRows(containers).map((c) => c.name),
        ["hot", "warm"]
    );
});

test("a card with nothing running shows no rows at all", () => {
    assert.deepEqual(containerRows([]), []);
    assert.deepEqual(
        containerRows([
            { name: "a", state: "exited" },
            { name: "b", state: "removed" },
        ]),
        []
    );
});
