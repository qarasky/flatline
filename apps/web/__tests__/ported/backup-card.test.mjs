import { test } from "vitest";
import assert from "node:assert/strict";
import { backupAttention, backupLines, backupVersion, groupBackupsByMonitor } from "@/lib/backup-card";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const hoursAgo = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();

function agent(name, health, overrides = {}) {
    return {
        id: `id-${name}`,
        name,
        monitorId: 48,
        enabled: health !== "disabled",
        credentialActive: true,
        intervalSeconds: 86400,
        retentionCount: 7,
        createdAt: hoursAgo(100),
        health,
        lastErrorCode: null,
        latestRun: null,
        lastCompletedRun: { exportFinishedAt: hoursAgo(3), completedAt: hoursAgo(2.9) },
        latestArchiveVerification: null,
        latestRestoreVerification: null,
        reportedVersion: "0.3.0",
        versionReportedAt: hoursAgo(1),
        updateStatus: "ok",
        ...overrides,
    };
}

test("one agent: a nameless last-backup line", () => {
    const lines = backupLines([agent("modernization", "healthy")], NOW);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, "last backup 3h ago");
    assert.equal(lines[0].tone, "quiet");
});

test("several agents: one named line each, sorted by name", () => {
    const lines = backupLines(
        [
            agent("zhkh", "healthy", { lastCompletedRun: { exportFinishedAt: hoursAgo(2), completedAt: null } }),
            agent("modernization", "healthy"),
        ],
        NOW
    );
    assert.deepEqual(
        lines.map((line) => line.text),
        ["modernization: last backup 3h ago", "zhkh: last backup 2h ago"]
    );
});

test("tone and copy follow the server's health", () => {
    const text = (a) => backupLines([a, agent("other", "healthy")], NOW).find((line) => line.key === a.id);
    const overdue = text(agent("zhkh", "overdue", { lastCompletedRun: { exportFinishedAt: hoursAgo(48) } }));
    assert.equal(overdue.text, "zhkh: last backup 2d ago");
    assert.equal(overdue.tone, "warn");

    const neverOverdue = text(agent("zhkh", "overdue", { lastCompletedRun: null }));
    assert.equal(neverOverdue.text, "zhkh: no backup yet");
    assert.equal(neverOverdue.tone, "warn");

    const failed = text(agent("zhkh", "failed", { lastErrorCode: "export_failed" }));
    assert.equal(failed.text, "zhkh: last backup 3h ago", "failed shows the last success");
    assert.equal(failed.tone, "warn");
    assert.match(failed.title, /export_failed/);

    const pending = text(agent("zhkh", "pending", { lastCompletedRun: null }));
    assert.equal(pending.text, "zhkh: no backup yet");
    assert.equal(pending.tone, "quiet", "a new agent is not a warning");

    const disabled = text(agent("zhkh", "disabled"));
    assert.equal(disabled.text, "zhkh: backups off");
    assert.equal(disabled.tone, "quiet");
});

test("falls back to completedAt when the export time is missing", () => {
    const lines = backupLines(
        [agent("modernization", "healthy", { lastCompletedRun: { exportFinishedAt: null, completedAt: hoursAgo(5) } })],
        NOW
    );
    assert.equal(lines[0].text, "last backup 5h ago");
});

test("revoked agents are hidden, and the remaining one loses its name", () => {
    const lines = backupLines(
        [agent("old", "overdue", { credentialActive: false }), agent("modernization", "healthy")],
        NOW
    );
    assert.deepEqual(
        lines.map((line) => line.text),
        ["last backup 3h ago"]
    );
});

test("the hover names the exact time and health", () => {
    const [line] = backupLines([agent("modernization", "healthy")], NOW);
    assert.match(line.title, /healthy/);
    assert.match(line.title, /2026/);
});

test("version: one value, or distinct values lowest first", () => {
    assert.equal(backupVersion([agent("a", "healthy")]).text, "backup 0.3.0");
    assert.equal(
        backupVersion([
            agent("a", "healthy", { reportedVersion: "0.3.0" }),
            agent("b", "healthy", { reportedVersion: "0.2.0" }),
            agent("c", "healthy", { reportedVersion: "0.3.0" }),
        ]).text,
        "backup 0.2.0/0.3.0"
    );
    assert.equal(
        backupVersion([
            agent("a", "healthy", { reportedVersion: "0.10.0" }),
            agent("b", "healthy", { reportedVersion: "0.9.0" }),
        ]).text,
        "backup 0.9.0/0.10.0",
        "versions compare numerically"
    );
});

test("version: none reported means no segment", () => {
    assert.equal(backupVersion([agent("a", "healthy", { reportedVersion: null })]), null);
    assert.equal(backupVersion([]), null);
});

test("version: a failing update turns it warn and says why", () => {
    const quiet = backupVersion([agent("a", "healthy")]);
    assert.equal(quiet.tone, "quiet");
    const failing = backupVersion([agent("a", "healthy", { updateStatus: "checksum_mismatch" })]);
    assert.equal(failing.tone, "warn");
    assert.match(failing.title, /checksum_mismatch/);
});

test("attention: overdue and failed flag the card; pending and disabled never do", () => {
    assert.deepEqual(backupAttention([agent("a", "healthy")]), { flagged: 0, headline: null });
    assert.deepEqual(backupAttention([agent("a", "overdue"), agent("b", "healthy")]), {
        flagged: 1,
        headline: "Backup overdue",
    });
    assert.deepEqual(backupAttention([agent("a", "overdue"), agent("b", "failed")]), {
        flagged: 2,
        headline: "2 backups behind",
    });
    assert.deepEqual(backupAttention([agent("a", "pending"), agent("b", "disabled")]), {
        flagged: 0,
        headline: null,
    });
    assert.deepEqual(backupAttention([agent("a", "overdue", { credentialActive: false })]), {
        flagged: 0,
        headline: null,
    });
});

test("agents are grouped by their monitor; unlinked agents go nowhere", () => {
    const grouped = groupBackupsByMonitor([
        agent("zhkh", "healthy", { monitorId: 48 }),
        agent("modernization", "healthy", { monitorId: 48 }),
        agent("cmn", "healthy", { monitorId: 47 }),
        agent("orphan", "healthy", { monitorId: null }),
    ]);
    assert.deepEqual([...grouped.keys()].sort(), [47, 48]);
    assert.deepEqual(
        grouped.get(48).map((a) => a.name),
        ["zhkh", "modernization"]
    );
});
