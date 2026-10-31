import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    deleteMonitor,
    fetchAllBackupAgents,
    fetchAllMonitors,
    fetchNotifications,
    pauseMonitor,
} from "@/lib/monitors-api";

type Call = { url: string; init: RequestInit };

/** Stub fetch with answers in order, recording each call. */
function stubFetch(...answers: unknown[]): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(answers[calls.length - 1]), { status: 200 });
        })
    );
    return calls;
}

describe("monitor API calls in the browser", () => {
    beforeEach(() => vi.stubGlobal("window", {}));
    afterEach(() => vi.unstubAllGlobals());

    it("deletes a group with its children as a cookie write", async () => {
        const calls = stubFetch({ ok: true, deleted: [5, 6], count: 2 });
        await deleteMonitor(5, true);
        expect(calls[0].url).toBe("/api/v1/monitors/5?deleteChildren=true");
        expect(calls[0].init.method).toBe("DELETE");
        expect(calls[0].init.headers).toMatchObject({ "X-Flatline-CSRF": "1" });
    });

    it("reads every page of the roster", async () => {
        const page = (ids: number[], hasMore: boolean) => ({
            ok: true,
            count: ids.length,
            monitors: ids.map((id) => ({ id })),
            pagination: { hasMore },
        });
        const calls = stubFetch(page([1, 2], true), page([3], false));
        const monitors = await fetchAllMonitors();
        expect(monitors.map((m) => m.id)).toEqual([1, 2, 3]);
        expect(calls.map((c) => c.url)).toEqual([
            "/api/v1/monitors?page=1&perPage=200",
            "/api/v1/monitors?page=2&perPage=200",
        ]);
    });

    it("lists notifications as summaries", async () => {
        stubFetch({
            ok: true,
            count: 1,
            notifications: [
                { id: 3, name: "ops", type: "telegram", active: true, isDefault: false, config: { chat: 1 } },
            ],
        });
        expect(await fetchNotifications()).toEqual([
            { id: 3, name: "ops", type: "telegram", active: true, isDefault: false },
        ]);
    });

    it("pauses by patching the monitor inactive", async () => {
        const calls = stubFetch({ ok: true, monitor: { id: 4 } });
        await pauseMonitor(4);
        expect(calls[0].url).toBe("/api/v1/monitors/4");
        expect(calls[0].init.method).toBe("PATCH");
        expect(calls[0].init.body).toBe('{"active":false}');
    });

    it("follows the backup agents' cursor", async () => {
        const calls = stubFetch(
            { ok: true, agents: [{ name: "a" }], nextCursor: "c1" },
            { ok: true, agents: [{ name: "b" }], nextCursor: null }
        );
        const agents = await fetchAllBackupAgents();
        expect(agents.map((a) => a.name)).toEqual(["a", "b"]);
        expect(calls.map((c) => c.url)).toEqual([
            "/api/v1/backup-agents?limit=200",
            "/api/v1/backup-agents?limit=200&cursor=c1",
        ]);
    });
});
