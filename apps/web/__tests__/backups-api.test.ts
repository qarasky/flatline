import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createBackupAgent,
    recordVerification,
    revokeBackupToken,
    rotateBackupToken,
    updateBackupAgent,
} from "@/lib/backups-api";
import { fetchLatestMetrics, fetchMetricsHistory } from "@/lib/monitors-api";

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, ...answers: unknown[]): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(answers[calls.length - 1]), { status });
        })
    );
    return calls;
}

describe("backup and metrics calls", () => {
    beforeEach(() => vi.stubGlobal("window", {}));
    afterEach(() => vi.unstubAllGlobals());

    it("rotates a backup token as a cookie write and returns the new token", async () => {
        const calls = stubFetch(200, { ok: true, agent: { id: "a1" }, token: "flatline_agent_backup_x" });
        const answer = await rotateBackupToken("a1");
        expect(answer.token).toBe("flatline_agent_backup_x");
        expect(calls[0].url).toBe("/api/v1/backup-agents/a1/rotate-token");
        expect(calls[0].init.method).toBe("POST");
        expect(calls[0].init.headers).toMatchObject({ "X-Flatline-CSRF": "1" });
    });

    it("revokes a backup token", async () => {
        const calls = stubFetch(200, { ok: true, agent: { id: "a1" } });
        await revokeBackupToken("a1");
        expect(calls[0].url).toBe("/api/v1/backup-agents/a1/revoke-token");
        expect(calls[0].init.method).toBe("POST");
    });

    it("updates an agent with a partial body", async () => {
        const calls = stubFetch(200, { ok: true, agent: { id: "a1" } });
        await updateBackupAgent("a1", { monitorId: null, enabled: false });
        expect(calls[0].init.method).toBe("PATCH");
        expect(calls[0].init.body).toBe('{"monitorId":null,"enabled":false}');
    });

    it("registers an agent and returns its token once", async () => {
        const calls = stubFetch(200, { ok: true, agent: { id: "a2" }, token: "flatline_agent_backup_y" });
        expect((await createBackupAgent({ name: "meks", monitorId: 4 })).token).toBe("flatline_agent_backup_y");
        expect(calls[0].url).toBe("/api/v1/backup-agents");
    });

    it("records a verification for a run", async () => {
        const calls = stubFetch(200, { ok: true });
        await recordVerification("r1", {
            kind: "restore",
            status: "passed",
            checkedAt: "2026-10-31T08:00:00Z",
            summary: "scratch container",
        });
        expect(calls[0].url).toBe("/api/v1/backup-runs/r1/verification");
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
            kind: "restore",
            status: "passed",
            checkedAt: "2026-10-31T08:00:00Z",
            summary: "scratch container",
        });
    });

    it("reads a server's history for a range", async () => {
        const calls = stubFetch(200, { ok: true, points: [] });
        await fetchMetricsHistory(7, 24);
        expect(calls[0].url).toBe("/api/v1/monitors/7/metrics/summary?hours=24");
    });

    it("treats a server with no sample yet as null", async () => {
        stubFetch(404, { ok: false, error: "not_found", message: "No metrics yet." });
        expect(await fetchLatestMetrics(9)).toBeNull();
    });
});
