import test from "node:test";
import assert from "node:assert/strict";
import { backupHealth, verificationLabel } from "../src/lib/backup-presentation.ts";

function run(overrides = {}) {
    return {
        id: "run-1",
        agentId: "agent-1",
        clientRunId: "client-1",
        status: "completed",
        exportStartedAt: "2026-10-19T00:00:00Z",
        exportFinishedAt: "2026-10-19T00:30:00Z",
        createdAt: "2026-10-19T00:31:00Z",
        completedAt: "2026-10-19T00:32:00Z",
        totalBytes: 2048,
        receivedBytes: 2048,
        sha256: "a".repeat(64),
        sourceSummary: { databaseCount: 1, objectCount: 2, sourceBytes: 1024 },
        errorCode: null,
        archiveVerification: null,
        restoreVerification: null,
        ...overrides,
    };
}

function agent(name, health, extra = {}) {
    return {
        id: `id-${name}`,
        name,
        monitorId: 5,
        enabled: health !== "disabled",
        credentialActive: true,
        intervalSeconds: 86400,
        retentionCount: 7,
        createdAt: "2026-10-01T00:00:00Z",
        health,
        lastErrorCode: null,
        latestRun: run(),
        lastCompletedRun: run(),
        latestArchiveVerification: null,
        latestRestoreVerification: null,
        ...extra,
    };
}

test("each named agent has its own health label", () => {
    assert.deepEqual(backupHealth(agent("meks", "healthy")), { label: "Healthy", tone: "up" });
    assert.deepEqual(backupHealth(agent("zhkhteam", "pending")), { label: "Pending", tone: "degraded" });
    assert.deepEqual(backupHealth(agent("meks", "failed")), { label: "Failed", tone: "down" });
    assert.deepEqual(backupHealth(agent("meks", "overdue")), { label: "Overdue", tone: "down" });
    assert.deepEqual(backupHealth(agent("meks", "disabled")), { label: "Disabled", tone: "neutral" });
});

test("transfer verification is never called a restore test", () => {
    assert.equal(verificationLabel(run()), "Not restore-tested");
    assert.equal(
        verificationLabel(
            run({ archiveVerification: { runId: "run-1", status: "passed", checkedAt: "x", summary: "ok" } })
        ),
        "Archive verified"
    );
    assert.equal(
        verificationLabel(
            run({ restoreVerification: { runId: "run-1", status: "passed", checkedAt: "x", summary: "ok" } })
        ),
        "Restore tested"
    );
    assert.equal(
        verificationLabel(
            run({ restoreVerification: { runId: "run-1", status: "failed", checkedAt: "x", summary: "no" } })
        ),
        "Restore failed"
    );
    assert.equal(verificationLabel(run({ status: "uploading", exportFinishedAt: null })), "Not completed");
});

test("API reads send Authorization and keep agents separate", async () => {
    const calls = [];
    globalThis.window = { localStorage: { getItem: () => "test-token" } };
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return new Response(
            JSON.stringify({
                ok: true,
                agents: [agent("meks", "healthy"), agent("zhkhteam", "failed")],
                runs: [run()],
                nextCursor: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    };
    const { fetchBackupAgents, fetchBackupRuns } = await import("../src/lib/api.ts");
    const agents = await fetchBackupAgents(5);
    assert.equal(agents.agents.length, 2);
    assert.equal(agents.agents[0].name, "meks");
    assert.equal(agents.agents[1].name, "zhkhteam");
    assert.match(calls[0].url, /\/api\/v1\/backup-agents\?monitorId=5$/);
    assert.equal(calls[0].headers.Authorization, "Bearer test-token");

    await fetchBackupRuns("agent-1");
    assert.match(calls[1].url, /\/api\/v1\/backup-agents\/agent-1\/runs$/);
    assert.equal(calls[1].headers.Authorization, "Bearer test-token");
});

test("binary downloads are blobs, not JSON", async () => {
    globalThis.window = { localStorage: { getItem: () => "test-token" } };
    const bytes = new Uint8Array([0x61, 0x67, 0x65, 0x00, 0xff]);
    let seen = null;
    globalThis.fetch = async (url, init) => {
        seen = { url: String(url), headers: init.headers };
        return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    };
    const { downloadBackup } = await import("../src/lib/api.ts");
    const blob = await downloadBackup("run-1");
    assert.ok(blob instanceof Blob);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
    assert.match(seen.url, /\/api\/v1\/backup-runs\/run-1\/download$/);
    assert.equal(seen.headers.Authorization, "Bearer test-token");
    assert.equal(seen.headers.Accept, "application/octet-stream");
});
