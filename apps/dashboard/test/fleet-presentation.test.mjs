import test from "node:test";
import assert from "node:assert/strict";
import {
    agentWarningCounts,
    agentWarnings,
    boardRouteFrom,
    clampMenuPosition,
    cleanMonitorName,
    containerIssue,
    containerStatsSummary,
    fleetAttention,
    formatBytes,
    formatBytesCompact,
    formatBytesPair,
    formatDuration,
    formatRate,
    groupSlug,
    matchGroups,
    percentage,
    sampleAgeMs,
    smartWarning,
    statusSlugFromPath,
    updatesStatus,
    containerAgeMs,
} from "../src/lib/fleet-presentation.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
test("freshness accepts SQL, UTC and offset timestamps; invalid data is stale", () => {
    for (const time of ["2026-10-09 11:59:00", "2026-10-09T11:59:00Z", "2026-10-09T13:59:00+02:00"]) {
        assert.equal(sampleAgeMs(time, now), 60_000);
    }
    assert.equal(sampleAgeMs("bad", now), Infinity);
    assert.equal(fleetAttention({}, "bad", 180, now).stale, true);
    assert.equal(fleetAttention({}, "2026-10-09 11:58:00", 180, now).stale, false);
    assert.equal(fleetAttention({}, "2026-10-09 11:56:59", 180, now).stale, true);
    assert.equal(fleetAttention({ sampleInterval: 1 }, "2026-10-09 11:59:54", 180, now).stale, true);
    assert.equal(fleetAttention({ sampleInterval: 1 }, "2026-10-09 11:59:56", 180, now).stale, false);
});
test("intentional stopped states and starting health are not failures", () => {
    for (const c of [
        { state: "exited", health: "unhealthy" },
        { state: "created" },
        { state: "paused" },
        { state: "running", health: "starting" },
    ]) {
        assert.equal(containerIssue(c), false);
    }
    for (const c of [{ state: "running", health: "unhealthy" }, { state: "dead" }, { state: "restarting" }]) {
        assert.equal(containerIssue(c), true);
    }
});
test("issues sort first without mutating the payload; collection failures are visible", () => {
    const docker = [
        { name: "a", state: "exited" },
        { name: "b", state: "restarting" },
    ];
    const state = fleetAttention({ docker, dockerError: "socket inaccessible" }, "2026-10-09T12:00:00Z", 180, now);
    assert.equal(state.issues, 2);
    assert.equal(state.containers[0].name, "b");
    assert.equal(docker[0].name, "a");
});
test("pending-update counts stay quiet until the backlog threshold; unknown stays silent", () => {
    assert.equal(updatesStatus(undefined), null);
    assert.equal(updatesStatus({}), null);
    assert.equal(updatesStatus({ total: -1 }), null);
    assert.deepEqual(updatesStatus({ total: 0 })?.label, "No updates");
    assert.deepEqual(updatesStatus({ total: 0 })?.tone, "ok");
    assert.deepEqual(updatesStatus({ total: 20 })?.tone, "quiet");
    assert.deepEqual(updatesStatus({ total: 49 })?.tone, "quiet");
    assert.deepEqual(updatesStatus({ total: 50 })?.tone, "warn");
    assert.deepEqual(updatesStatus({ total: 70 })?.label, "Updates: 70");
    assert.deepEqual(updatesStatus({ total: 70 })?.tone, "warn");
    // Any reported security updates dominate, whatever the total.
    assert.deepEqual(updatesStatus({ total: 80, security: 8 })?.tone, "critical");
    assert.deepEqual(updatesStatus({ total: 80, security: 8 })?.label, "Security Updates: 8");
    assert.deepEqual(updatesStatus({ total: 3, security: 1 })?.tone, "critical");
    assert.deepEqual(updatesStatus({ total: 5, security: 0 })?.tone, "quiet");
});

test("a required reboot outranks the counts and names what is pending", () => {
    assert.deepEqual(updatesStatus({ total: 0, rebootRequired: true })?.tone, "reboot");
    assert.equal(updatesStatus({ total: 0, rebootRequired: true })?.label, "Reboot required");
    assert.equal(updatesStatus({ total: 12, rebootRequired: true })?.label, "Updates: 12 · reboot required");
    assert.equal(
        updatesStatus({ total: 80, security: 8, rebootRequired: true })?.label,
        "Security Updates: 8 · reboot required"
    );
    assert.equal(updatesStatus({ total: 80, security: 8, rebootRequired: true })?.tone, "reboot");
    // An explicit false is just the ordinary mapping, not a reboot.
    assert.equal(updatesStatus({ total: 12, rebootRequired: false })?.tone, "quiet");
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
    assert.deepEqual(
        matchGroups(roster, "work").map((g) => g.id),
        [1]
    );
    assert.deepEqual(
        matchGroups(roster, "PERSONAL").map((g) => g.id),
        [2]
    );
    assert.deepEqual(
        matchGroups(roster, "work,personal").map((g) => g.id),
        [1, 2]
    );
    assert.deepEqual(
        matchGroups(roster, "work, work").map((g) => g.id),
        [1]
    );
    assert.deepEqual(matchGroups(roster, "nope"), []);
    assert.deepEqual(matchGroups(roster, ""), []);
});
test("rename input trims, caps, and rejects empties; menus stay on-screen", () => {
    assert.equal(cleanMonitorName("  db-01  "), "db-01");
    assert.equal(cleanMonitorName("   "), null);
    assert.equal(cleanMonitorName("x".repeat(300))?.length, 255);
    assert.deepEqual(clampMenuPosition(10, 10, 176, 40, 1920, 1080), { x: 10, y: 10 });
    assert.deepEqual(clampMenuPosition(1900, 1060, 176, 40, 1920, 1080), { x: 1736, y: 1032 });
    assert.deepEqual(clampMenuPosition(-50, -50, 176, 40, 1920, 1080), { x: 8, y: 8 });
});
test("agent warnings stay quiet when clean and exclude docker (shown elsewhere)", () => {
    assert.equal(agentWarnings(undefined), null);
    assert.equal(agentWarnings({ version: "1.4.0", uptime: 90 }), null);
    // Docker failures already render as the container-section error line.
    assert.equal(agentWarnings({ collectorErrors: { docker: 8640 } }), null);
    const warn = agentWarnings({
        version: "1.4.0",
        uptime: 7200,
        collectorErrors: { gpu: 3, updates: 2 },
        failedPushes: 2,
        samplesDropped: 1,
        lastError: "push: connection refused",
    });
    assert.equal(warn?.text, "Agent: 5 collector errors · 2 push failures · 1 sample dropped");
    assert.match(warn.title, /Agent 1\.4\.0/);
    assert.match(warn.title, /running 2h/);
    assert.match(warn.title, /gpu 3, updates 2/);
    assert.match(warn.title, /connection refused/);
    assert.equal(agentWarnings({ collectorErrors: { cpu: 1 } })?.text, "Agent: 1 collector error");
});
test("acknowledged agent counters stay cleared and only new ones show", () => {
    const agent = {
        version: "1.7.0",
        uptime: 600,
        failedPushes: 7,
        samplesDropped: 4,
        collectorErrors: { gpu: 5, updates: 2, docker: 99 },
    };
    // Nothing acknowledged yet: the whole line shows, docker excluded.
    assert.equal(agentWarnings(agent)?.text, "Agent: 7 collector errors · 7 push failures · 4 samples dropped");

    // The operator clears everything the card was showing.
    const acks = { pushFailuresAck: 7, samplesDroppedAck: 4, collectorErrorsAck: { gpu: 5, updates: 2 } };
    assert.equal(agentWarnings(agent, acks), null);
    assert.equal(agentWarningCounts(agent, acks).total, 0);

    // Only failures past the acknowledged value are news again, per counter.
    const grown = { ...agent, failedPushes: 9, samplesDropped: 5, collectorErrors: { gpu: 8, updates: 2, docker: 99 } };
    const counts = agentWarningCounts(grown, acks);
    assert.deepEqual(counts.collectors, [["gpu", 3]]);
    assert.equal(counts.collectorErrors, 3);
    assert.equal(counts.failedPushes, 2);
    assert.equal(counts.samplesDropped, 1);
    assert.equal(counts.total, 6);
    assert.equal(agentWarnings(grown, acks)?.text, "Agent: 3 collector errors · 2 push failures · 1 sample dropped");

    // A stale ack from before a restart can never drive a count below zero.
    const stale = agentWarningCounts({ collectorErrors: { gpu: 1 } }, { collectorErrorsAck: { gpu: 5 } });
    assert.deepEqual(stale, { collectorErrors: 0, failedPushes: 0, samplesDropped: 0, collectors: [], total: 0 });
});
test("durations format compactly for cards and tooltips", () => {
    for (const v of [undefined, NaN, 0, -5]) {
        assert.equal(formatDuration(v), null);
    }
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(600), "10m");
    assert.equal(formatDuration(7200), "2h");
    assert.equal(formatDuration(3 * 86400), "3d");
});
test("bytes and rates format compactly; a real zero rate stays visible", () => {
    assert.equal(formatBytes(undefined), "—");
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(15 * 1024 * 1024), "15.0 MB");
    assert.equal(formatRate(undefined), null);
    assert.equal(formatRate(NaN), null);
    assert.equal(formatRate(-1), null);
    assert.equal(formatRate(0), "0 B/s", "an idle interface is data, not missing");
    assert.equal(formatRate(2_500_000), "2.4 MB/s");
});
test("paired figures share one unit, and never fake it across units", () => {
    assert.equal(formatBytesPair(24 * 1024 ** 3, 36 * 1024 ** 3), "24 / 36 (GB)");
    assert.equal(formatBytesPair(15 * 1024 ** 3, 16 * 1024 ** 3), "15 / 16 (GB)");
    assert.equal(formatBytesPair(1.5 * 1024 ** 3, 2 * 1024 ** 3), "1.5 / 2 (GB)");
    assert.equal(formatBytesPair(900 * 1024 ** 3, 2 * 1024 ** 4), "900 GB / 2.0 TB");
    assert.equal(formatBytesPair(undefined, 100), null);
    assert.equal(formatBytesPair(100, undefined), null);
});
test("container stats stay honest: no stats means no label, zero CPU is a reading", () => {
    assert.equal(containerStatsSummary(undefined), null);
    assert.equal(containerStatsSummary({}), null);
    assert.equal(formatBytesCompact(512 * 1024 * 1024), "512M");
    assert.equal(formatBytesCompact(1.5 * 1024 ** 3), "1.5G");
    assert.equal(formatBytesCompact(undefined), null);

    const idle = containerStatsSummary({
        cpuPercent: 0,
        memUsed: 256 * 1024 * 1024,
        memLimit: 1024 ** 3,
        memPercent: 25,
    });
    assert.equal(idle?.label, "0% · 256M", "an idle container shows 0%, not nothing");
    assert.match(idle.title, /CPU 0\.0%/);
    assert.match(idle.title, /memory 256 MB of 1\.0 GB \(25%\)/);

    const busy = containerStatsSummary({ cpuPercent: 412.34, memUsed: 1024 });
    assert.equal(busy?.label, "412% · 1.0K", "Docker's per-core convention survives (can exceed 100%)");
    assert.match(busy.title, /CPU 412\.3%/);

    const memOnly = containerStatsSummary({ memUsed: 2048 });
    assert.equal(memOnly?.label, "2.0K");
    assert.doesNotMatch(memOnly.title, /CPU/);
});
test("smart warnings speak only for real trouble", () => {
    assert.equal(smartWarning(undefined), null);
    assert.equal(smartWarning({ available: false }), null);
    assert.equal(smartWarning({ available: true, disks: [] }), null);
    assert.equal(smartWarning({ available: true, disks: [{ device: "sda", health: "passed" }] }), null);

    const failing = smartWarning({
        available: true,
        disks: [
            { device: "sda", health: "passed", tempC: 38 },
            { device: "sdb", health: "failed", reallocatedSectors: 512, powerOnHours: 12345 },
        ],
    });
    assert.equal(failing?.tone, "bad");
    assert.equal(failing?.text, "SMART sdb: failing");
    assert.match(failing.title, /sda: passed, 38°C/);
    assert.match(failing.title, /sdb: failed, 512 reallocated, 514d on/);

    const many = smartWarning({
        available: true,
        disks: [
            { device: "sda", health: "failed" },
            { device: "sdb", health: "failed" },
        ],
    });
    assert.equal(many?.text, "SMART: 2 disks failing");

    const worn = smartWarning({ available: true, disks: [{ device: "nvme0n1", health: "passed", wearPercent: 85 }] });
    assert.equal(worn?.tone, "warn");
    assert.equal(worn?.text, "SSD wear 85% (nvme0n1)");
    assert.equal(smartWarning({ available: true, disks: [{ device: "nvme0n1", wearPercent: 79 }] }), null);

    // Failing outranks wear when both exist.
    const both = smartWarning({
        available: true,
        disks: [
            { device: "sda", health: "failed" },
            { device: "nvme0n1", wearPercent: 99 },
        ],
    });
    assert.equal(both?.tone, "bad");
});
test("status routes parse slugs; other paths are not status routes", () => {
    assert.equal(statusSlugFromPath("/status/client-a"), "client-a");
    assert.equal(statusSlugFromPath("/status/client-a/"), "client-a");
    assert.equal(statusSlugFromPath("/status/Aiel%20Qorgan"), "Aiel Qorgan");
    assert.equal(statusSlugFromPath("/status/a/b"), null, "slugs are single segments");
    assert.equal(statusSlugFromPath("/status/"), null);
    assert.equal(statusSlugFromPath("/"), null);
    assert.equal(statusSlugFromPath("/superboard/kiosk"), null);
});
test("high usage includes memory, disks and legacy GPU VRAM; unknown numbers stay unknown", () => {
    assert.equal(
        fleetAttention({ gpu: { available: true, memTotal: 100, memUsed: 95 } }, "2026-10-09T12:00:00Z", 180, now).hot,
        true
    );
    assert.equal(
        fleetAttention({ cpu: { percent: NaN }, mem: { percent: 3 } }, "2026-10-09T12:00:00Z", 180, now).hot,
        false
    );
    for (const v of [undefined, NaN, Infinity]) {
        assert.equal(percentage(v), "—");
    }
    assert.equal(percentage(0.1), "0.1%");
    assert.equal(percentage(110), "100%");
});

test("container freshness: old container lists are reported as old, never as current", () => {
    // The agent collects containers every 10s. A stalling daemon used to keep
    // republishing the previous snapshot under a fresh sample timestamp with
    // nothing to distinguish it; `dockerAt` gives the card the age.
    const sampledAt = "2026-10-14 12:00:00.000";
    const fresh = { dockerAt: "2026-10-14T11:59:55.000Z" };
    const aged = { dockerAt: "2026-10-14T11:55:00.000Z" };

    assert.equal(containerAgeMs(fresh, sampledAt), 5000);
    assert.equal(containerAgeMs(aged, sampledAt), 5 * 60_000);
    assert.equal(containerAgeMs({}, sampledAt), null, "older agents carry no dockerAt");
    assert.equal(containerAgeMs({ dockerAt: "not a time" }, sampledAt), null);
    assert.equal(containerAgeMs(fresh, ""), null, "an unusable sample time says nothing");
});
