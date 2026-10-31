import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { bulkFailureMessage, splitDeleteResults } from "@/lib/bulk-report";

describe("bulk results", () => {
    const monitors = [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
        { id: 3, name: "C" },
    ];

    it("names the monitors that failed", () => {
        const results: PromiseSettledResult<unknown>[] = [
            { status: "fulfilled", value: {} },
            { status: "rejected", reason: new ApiError(500, "server_error", "boom") },
            { status: "fulfilled", value: {} },
        ];
        expect(splitDeleteResults(monitors, results)).toEqual({ deleted: [1, 3], failed: ["B"] });
    });

    it("counts a monitor someone else already deleted as deleted", () => {
        const results: PromiseSettledResult<unknown>[] = [
            { status: "rejected", reason: new ApiError(404, "not_found", "gone") },
            { status: "fulfilled", value: {} },
            { status: "fulfilled", value: {} },
        ];
        expect(splitDeleteResults(monitors, results)).toEqual({ deleted: [1, 2, 3], failed: [] });
    });

    it("words the failure, or says nothing", () => {
        expect(bulkFailureMessage("delete", ["B", "C"])).toBe("Could not delete B, C.");
        expect(bulkFailureMessage("pause", [])).toBeNull();
    });
});
