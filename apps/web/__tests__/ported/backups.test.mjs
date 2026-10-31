import { test } from "vitest";
import assert from "node:assert/strict";
import {
    backupFileName,
    backupHealth,
    backupIsEncrypted,
    backupSourceSummary,
    restoreLabel,
    verificationLabel,
} from "@/lib/backup-presentation";

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
    assert.equal(verificationLabel(run()), "Transfer verified");
    assert.equal(
        verificationLabel(
            run({ archiveVerification: { runId: "run-1", status: "passed", checkedAt: "x", summary: "ok" } })
        ),
        "Transfer verified"
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

test("the agent-level restore result points at the tested run", () => {
    const tested = agent("meks", "healthy", {
        latestRestoreVerification: { runId: "older-run", status: "passed", checkedAt: "x", summary: "ok" },
    });
    assert.equal(restoreLabel(tested), "Restore tested");
    const failed = agent("meks", "healthy", {
        latestRestoreVerification: { runId: "older-run", status: "failed", checkedAt: "x", summary: "no" },
    });
    assert.equal(restoreLabel(failed), "Restore failed");
    assert.equal(restoreLabel(agent("meks", "healthy")), "Not restore-tested");
});

test("API reads ride on the session cookie and keep agents separate", async () => {
    const calls = [];
    globalThis.window = {};
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers, credentials: init.credentials });
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
    const { fetchBackupAgents, fetchBackupRuns } = await import("@/lib/backups-api");
    const agents = await fetchBackupAgents(5);
    assert.equal(agents.agents.length, 2);
    assert.equal(agents.agents[0].name, "meks");
    assert.equal(agents.agents[1].name, "zhkhteam");
    assert.match(calls[0].url, /\/api\/v1\/backup-agents\?monitorId=5$/);
    assert.equal(calls[0].credentials, "same-origin");
    assert.equal("Authorization" in calls[0].headers, false);

    await fetchBackupRuns("agent-1");
    assert.match(calls[1].url, /\/api\/v1\/backup-agents\/agent-1\/runs$/);
    assert.equal("Authorization" in calls[1].headers, false);
});

test("downloads use a single-use ticket URL, never a buffered blob", async () => {
    globalThis.window = {};
    let seen = null;
    globalThis.fetch = async (url, init) => {
        seen = { url: String(url), method: init.method, headers: init.headers, credentials: init.credentials };
        return new Response(
            JSON.stringify({
                ok: true,
                runId: "run-1",
                url: "/api/v1/backup-downloads/fbd_once",
                expiresAt: "2026-10-21T00:02:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    };
    const { backupDownloadUrl } = await import("@/lib/backups-api");
    const url = await backupDownloadUrl("run-1");
    assert.match(seen.url, /\/api\/v1\/backup-runs\/run-1\/download-ticket$/);
    assert.equal(seen.method, "POST");
    assert.equal(seen.credentials, "same-origin");
    assert.equal(seen.headers["X-Flatline-CSRF"], "1");
    assert.equal("Authorization" in seen.headers, false);
    assert.match(url, /\/api\/v1\/backup-downloads\/fbd_once$/);
});

test("encryption is read from the run summary; absent means an older, always-encrypting agent", () => {
    const plain = run({ sourceSummary: { databaseCount: 1, objectCount: 2, sourceBytes: 1024, encrypted: false } });
    const sealed = run({ sourceSummary: { databaseCount: 1, objectCount: 2, sourceBytes: 1024, encrypted: true } });
    const legacy = run();
    assert.equal(backupIsEncrypted(plain), false);
    assert.equal(backupIsEncrypted(sealed), true);
    assert.equal(backupIsEncrypted(legacy), true);
    assert.equal(backupIsEncrypted(run({ sourceSummary: null })), true);
});

test("download names match the bundle format", () => {
    const plain = run({ sourceSummary: { databaseCount: 1, objectCount: 0, sourceBytes: 1, encrypted: false } });
    assert.equal(backupFileName(plain), "flatline-backup-run-1.tar");
    assert.equal(backupFileName(run()), "flatline-backup-run-1.age");
});

test("only encrypted runs are marked: plain is the default", () => {
    const plain = run({ sourceSummary: { databaseCount: 1, objectCount: 2, sourceBytes: 1024, encrypted: false } });
    const sealed = run({ sourceSummary: { databaseCount: 1, objectCount: 2, sourceBytes: 1024, encrypted: true } });
    assert.doesNotMatch(backupSourceSummary(plain), /encrypted/);
    assert.match(backupSourceSummary(sealed), / · encrypted$/);
});

test("the board loads every backup agent, following nextCursor", async () => {
    const all = Array.from({ length: 60 }, (_, index) => agent(`agent-${String(index).padStart(2, "0")}`, "healthy"));
    const calls = [];
    globalThis.window = {};
    globalThis.fetch = async (url) => {
        const parsed = new URL(String(url), "http://board.test");
        calls.push(parsed);
        const start = Number(parsed.searchParams.get("cursor") ?? "0");
        const page = all.slice(start, start + 20);
        const next = start + 20 < all.length ? String(start + 20) : null;
        return new Response(JSON.stringify({ ok: true, agents: page, nextCursor: next }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    const { fetchAllBackupAgents } = await import("@/lib/monitors-api");
    const agents = await fetchAllBackupAgents();
    assert.equal(agents.length, 60);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].searchParams.get("cursor"), null);
    assert.equal(calls[1].searchParams.get("cursor"), "20");
    assert.equal(calls[2].searchParams.get("cursor"), "40");
    for (const call of calls) {
        assert.equal(call.pathname, "/api/v1/backup-agents");
        assert.equal(call.searchParams.get("monitorId"), null, "one request for the whole board, not per card");
    }
});
