import { afterEach, describe, expect, it, vi } from "vitest";

import { isNewBuild, startVersionWatch } from "@/lib/build-id";

describe("isNewBuild", () => {
    it("is new only when both builds are known and differ", () => {
        expect(isNewBuild("a", "b")).toBe(true);
        expect(isNewBuild("a", "a")).toBe(false);
        expect(isNewBuild(null, "b")).toBe(false);
        expect(isNewBuild("a", null)).toBe(false);
    });
});

describe("startVersionWatch", () => {
    afterEach(() => vi.useRealTimers());

    it("reports a new deploy once, when the served build changes", async () => {
        const onNewVersion = vi.fn();
        const stop = startVersionWatch({ onNewVersion, loaded: "a", fetchServed: async () => "b" });
        await vi.waitFor(() => expect(onNewVersion).toHaveBeenCalledTimes(1));
        stop();
    });

    it("stays quiet while the served build is the same", async () => {
        const onNewVersion = vi.fn();
        const fetchServed = vi.fn(async () => "a");
        const stop = startVersionWatch({ onNewVersion, loaded: "a", fetchServed });
        await vi.waitFor(() => expect(fetchServed).toHaveBeenCalled());
        expect(onNewVersion).not.toHaveBeenCalled();
        stop();
    });

    it("does nothing in development, where the build has no id", () => {
        const fetchServed = vi.fn(async () => "b");
        const stop = startVersionWatch({ onNewVersion: vi.fn(), loaded: null, fetchServed });
        expect(fetchServed).not.toHaveBeenCalled();
        stop();
    });
});
