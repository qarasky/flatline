import test from "node:test";
import assert from "node:assert/strict";
import { boardRouteFrom, containerIssue, fleetAttention, groupSlug, matchGroups, percentage, sampleAgeMs, updatesStatus } from "../src/lib/fleet-presentation.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
test("freshness accepts SQL, UTC and offset timestamps; invalid data is stale", () => {
    for (const time of ["2026-10-09 11:59:00", "2026-10-09T11:59:00Z", "2026-10-09T13:59:00+02:00"]) {
        assert.equal(sampleAgeMs(time, now), 60_000);
    }
    assert.equal(sampleAgeMs("bad", now), Infinity);
    assert.equal(fleetAttention({}, "bad", 180, now).stale, true);
    assert.equal(fleetAttention({}, "2026-10-09 11:58:00", 180, now).stale, false);
    assert.equal(fleetAttention({}, "2026-10-09 11:56:59", 180, now).stale, true);
    assert.equal(fleetAttention({sampleInterval:1}, "2026-10-09 11:59:54", 180, now).stale, true);
    assert.equal(fleetAttention({sampleInterval:1}, "2026-10-09 11:59:56", 180, now).stale, false);
});
test("intentional stopped states and starting health are not failures", () => {
    for (const c of [{state:"exited", health:"unhealthy"}, {state:"created"}, {state:"paused"}, {state:"running", health:"starting"}]) {
        assert.equal(containerIssue(c), false);
    }
    for (const c of [{state:"running", health:"unhealthy"}, {state:"dead"}, {state:"restarting"}]) {
        assert.equal(containerIssue(c), true);
    }
});
test("issues sort first without mutating the payload; collection failures are visible", () => {
    const docker = [{name:"a", state:"exited"}, {name:"b", state:"restarting"}];
    const state = fleetAttention({docker, dockerError:"socket inaccessible"}, "2026-10-09T12:00:00Z", 180, now);
    assert.equal(state.issues, 2);
    assert.equal(state.containers[0].name, "b");
    assert.equal(docker[0].name, "a");
});
test("pending-update counts map to green/yellow/red/dark-red; unknown stays silent", () => {
    assert.equal(updatesStatus(undefined), null);
    assert.equal(updatesStatus({}), null);
    assert.equal(updatesStatus({ total: -1 }), null);
    assert.deepEqual(updatesStatus({ total: 0 })?.label, "No updates");
    assert.deepEqual(updatesStatus({ total: 0 })?.tone, "ok");
    assert.deepEqual(updatesStatus({ total: 20 })?.tone, "warn");
    assert.deepEqual(updatesStatus({ total: 49 })?.tone, "warn");
    assert.deepEqual(updatesStatus({ total: 50 })?.tone, "bad");
    assert.deepEqual(updatesStatus({ total: 70 })?.label, "Updates: 70");
    // Any reported security updates dominate, whatever the total.
    assert.deepEqual(updatesStatus({ total: 80, security: 8 })?.tone, "critical");
    assert.deepEqual(updatesStatus({ total: 80, security: 8 })?.label, "Security Updates: 8");
    assert.deepEqual(updatesStatus({ total: 3, security: 1 })?.tone, "critical");
    assert.deepEqual(updatesStatus({ total: 5, security: 0 })?.tone, "warn");
});
test("board routes resolve kiosk and group scopes; nothing else is a board", () => {
    assert.deepEqual(boardRouteFrom("/superboard"), { kiosk: false, filter: null });
    assert.deepEqual(boardRouteFrom("/superboard/"), { kiosk: false, filter: null });
    assert.deepEqual(boardRouteFrom("/superboard/kiosk"), { kiosk: true, filter: null });
    assert.deepEqual(boardRouteFrom("/superboard/kiosk/"), { kiosk: true, filter: null });
    assert.deepEqual(boardRouteFrom("/superboard/work"), { kiosk: false, filter: "work" });
    assert.deepEqual(boardRouteFrom("/superboard/kiosk/work"), { kiosk: true, filter: "work" });
    assert.deepEqual(boardRouteFrom("/superboard/kiosk/work,personal"), { kiosk: true, filter: "work,personal" });
    assert.deepEqual(boardRouteFrom("/"), null);
    assert.deepEqual(boardRouteFrom("/invite/abc"), null);
    assert.deepEqual(boardRouteFrom("/monitors"), null);
});
test("group slugs match names case-insensitively; servers can never match", () => {
    assert.equal(groupSlug("Aiel Qorgan"), "aiel-qorgan");
    assert.equal(groupSlug("work"), "work");
    const roster = [
        { id: 1, name: "work", type: "group" },
        { id: 2, name: "Personal", type: "group" },
        { id: 3, name: "work", type: "push" },
        { id: 4, name: "db", type: "push", parent: 1 },
    ];
    assert.deepEqual(matchGroups(roster, "work").map(g => g.id), [1]);
    assert.deepEqual(matchGroups(roster, "PERSONAL").map(g => g.id), [2]);
    assert.deepEqual(matchGroups(roster, "work,personal").map(g => g.id), [1, 2]);
    assert.deepEqual(matchGroups(roster, "work, work").map(g => g.id), [1]);
    assert.deepEqual(matchGroups(roster, "nope"), []);
    assert.deepEqual(matchGroups(roster, ""), []);
});
test("high usage includes memory, disks and legacy GPU VRAM; unknown numbers stay unknown", () => {
    assert.equal(fleetAttention({gpu:{available:true, memTotal:100, memUsed:95}}, "2026-10-09T12:00:00Z", 180, now).hot, true);
    assert.equal(fleetAttention({cpu:{percent:NaN}, mem:{percent:3}}, "2026-10-09T12:00:00Z", 180, now).hot, false);
    for (const v of [undefined, NaN, Infinity]) { assert.equal(percentage(v), "—"); }
    assert.equal(percentage(0.1), "0.1%");
    assert.equal(percentage(110), "100%");
});
