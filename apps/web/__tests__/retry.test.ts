import { describe, expect, it } from "vitest";

import { retryDelayMs } from "@/lib/retry";

describe("retryDelayMs", () => {
    it("starts at two seconds and doubles", () => {
        expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000]);
    });

    it("caps at thirty seconds", () => {
        expect(retryDelayMs(4)).toBe(30_000);
        expect(retryDelayMs(50)).toBe(30_000);
    });
});
