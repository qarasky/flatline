import { describe, expect, it } from "vitest";

import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
    it("keeps a same-site path with its query", () => {
        expect(safeNext("/monitors/12?x=1")).toBe("/monitors/12?x=1");
    });

    const bad = [
        null,
        undefined,
        "",
        "monitors",
        "//evil.example",
        "https://evil.example",
        "/\\evil.example",
        "javascript:alert(1)",
        "/sign-in",
        "/sign-in?next=/x",
        // The URL parser strips tab, CR and LF first: "/\t/evil" is "//evil".
        "/\t/evil.example",
        "/\n/evil.example",
        "/\r/evil.example",
        "/\u0000/evil.example",
    ];
    for (const value of bad) {
        it(`falls back to /monitors for ${JSON.stringify(value)}`, () => {
            expect(safeNext(value)).toBe("/monitors");
        });
    }
});
