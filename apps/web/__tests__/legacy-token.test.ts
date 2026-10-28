import { describe, expect, it, vi } from "vitest";

import { migrateLegacyToken, type SessionResult } from "@/lib/legacy-token";

function storage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key: string) => map.get(key) ?? null,
        removeItem: (key: string) => void map.delete(key),
    };
}

const session = (result: SessionResult) => vi.fn(async (_token: string) => result);

describe("migrateLegacyToken", () => {
    it("does nothing without an old token", async () => {
        const create = session("ok");
        expect(await migrateLegacyToken({ storage: storage(), createSession: create })).toBe("none");
        expect(create).not.toHaveBeenCalled();
    });

    it("turns the old token into a session and forgets it", async () => {
        const store = storage({ "flatline.token": "flatline_op_tv" });
        const create = session("ok");
        expect(await migrateLegacyToken({ storage: store, createSession: create })).toBe("migrated");
        expect(create).toHaveBeenCalledWith("flatline_op_tv");
        expect(store.map.has("flatline.token")).toBe(false);
    });

    it("forgets a revoked token", async () => {
        const store = storage({ "flatline.token": "flatline_op_old" });
        expect(await migrateLegacyToken({ storage: store, createSession: session("rejected") })).toBe("rejected");
        expect(store.map.has("flatline.token")).toBe(false);
    });

    it("keeps the token when Flatline cannot be reached", async () => {
        const store = storage({ "flatline.token": "flatline_op_tv" });
        expect(await migrateLegacyToken({ storage: store, createSession: session("error") })).toBe("error");
        expect(store.map.get("flatline.token")).toBe("flatline_op_tv");
    });

    it("treats unreadable storage as no token", async () => {
        const broken = {
            getItem: () => {
                throw new Error("denied");
            },
            removeItem: () => {},
        };
        expect(await migrateLegacyToken({ storage: broken, createSession: session("ok") })).toBe("none");
    });
});

describe("keepMigrating", () => {
    it("retries while Flatline cannot be reached, so an unattended screen signs itself in", async () => {
        const { keepMigrating } = await import("@/lib/legacy-token");
        const store = storage({ "flatline.token": "flatline_op_tv" });
        const results: SessionResult[] = ["error", "error", "ok"];
        const create = vi.fn(async () => results.shift() ?? "ok");
        const waits: number[] = [];
        const outcome = await keepMigrating({
            storage: store,
            createSession: create,
            wait: async (ms) => void waits.push(ms),
        });
        expect(outcome).toBe("migrated");
        expect(create).toHaveBeenCalledTimes(3);
        expect(waits).toEqual([2_000, 4_000]);
        expect(store.map.has("flatline.token")).toBe(false);
    });

    it("stops when told to", async () => {
        const { keepMigrating } = await import("@/lib/legacy-token");
        const store = storage({ "flatline.token": "flatline_op_tv" });
        const controller = new AbortController();
        const outcome = await keepMigrating({
            storage: store,
            createSession: async () => "error",
            wait: async () => controller.abort(),
            signal: controller.signal,
        });
        expect(outcome).toBe("error");
        expect(store.map.get("flatline.token")).toBe("flatline_op_tv");
    });
});
