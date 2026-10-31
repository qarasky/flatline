import { describe, expect, it } from "vitest";

import { toSearchString } from "@/lib/search-string";

describe("toSearchString", () => {
    it("repeats arrays and skips undefined", () => {
        expect(toSearchString({ status: ["down", "pending"], q: "kz", m: undefined })).toBe(
            "?status=down&status=pending&q=kz"
        );
    });

    it("is empty for no params", () => {
        expect(toSearchString({})).toBe("");
    });

    it("encodes values", () => {
        expect(toSearchString({ q: "a b&c" })).toBe("?q=a+b%26c");
    });
});
