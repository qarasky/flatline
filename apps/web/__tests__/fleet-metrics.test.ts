import { describe, expect, it } from "vitest";

import { applyMetricEvents, mergeMetricChunks, orNull } from "@/lib/fleet-metrics";
import type { ServerSample } from "@/lib/server-row";

const sample = (time: string): ServerSample => ({ time, metrics: {} });

describe("mergeMetricChunks", () => {
    it("takes every chunk that loaded", () => {
        const { samples, failed } = mergeMetricChunks(
            [[1, 2], [3]],
            [
                { status: "fulfilled", value: { samples: { 1: sample("a"), 2: null } } },
                { status: "fulfilled", value: { samples: { 3: sample("c") } } },
            ],
            new Map()
        );
        expect([...samples.keys()]).toEqual([1, 3]);
        expect(failed).toBe(false);
    });

    it("keeps what it had for a chunk that failed, and says so", () => {
        const previous = new Map([[3, sample("old")]]);
        const { samples, failed } = mergeMetricChunks(
            [[1], [3]],
            [
                { status: "fulfilled", value: { samples: { 1: sample("a") } } },
                { status: "rejected", reason: new Error("500") },
            ],
            previous
        );
        expect(samples.get(3)?.time).toBe("old");
        expect(samples.get(1)?.time).toBe("a");
        expect(failed).toBe(true);
    });
});

describe("applyMetricEvents", () => {
    it("applies a batch in one copy, the last sample per server winning", () => {
        const before = new Map([[1, sample("t0")]]);
        const after = applyMetricEvents(before, [
            { monitorId: 1, time: "t1", metrics: {} },
            { monitorId: 2, time: "t1", metrics: {} },
            { monitorId: 1, time: "t2", metrics: {} },
        ]);
        expect(after.get(1)?.time).toBe("t2");
        expect(after.get(2)?.time).toBe("t1");
        expect(before.get(1)?.time).toBe("t0");
    });

    it("returns the same map for an empty batch", () => {
        const before = new Map([[1, sample("t0")]]);
        expect(applyMetricEvents(before, [])).toBe(before);
    });
});

describe("orNull", () => {
    it("turns a failed optional read into null", async () => {
        expect(await orNull(Promise.reject(new Error("500")))).toBeNull();
        expect(await orNull(Promise.resolve(3))).toBe(3);
    });
});
