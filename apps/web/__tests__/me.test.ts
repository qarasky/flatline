import { describe, expect, it } from "vitest";

import { displayName, initials, toMe } from "@/lib/me";

describe("displayName", () => {
    it("names an account by its name", () => {
        expect(
            displayName({
                principal: "account",
                account: { id: 1, email: "a@x.kz", name: "Ana Bek", mustChangePassword: false },
            })
        ).toBe("Ana Bek");
    });

    it("names a token session by its token", () => {
        expect(displayName({ principal: "token", token: { id: 3, name: "Wall TV" } })).toBe("Wall TV");
    });

    it("falls back when a token has no name", () => {
        expect(displayName({ principal: "token", token: { id: 3, name: "" } })).toBe("Operator");
    });
});

describe("initials", () => {
    it("takes the first letters of the first two words", () => {
        expect(initials("Ana Bek")).toBe("AB");
        expect(initials("ana")).toBe("A");
        expect(initials("Ana Maria Bek")).toBe("AM");
    });

    it("has a placeholder for an empty name", () => {
        expect(initials("  ")).toBe("?");
    });
});

describe("toMe", () => {
    it("keeps only who is signed in from /auth/me", () => {
        expect(
            toMe({
                ok: true,
                principal: "account",
                account: { id: 1, email: "a@x.kz", name: "Ana", mustChangePassword: true },
                capabilities: ["gui"],
            })
        ).toEqual({
            principal: "account",
            account: { id: 1, email: "a@x.kz", name: "Ana", mustChangePassword: true },
        });
        expect(toMe({ ok: true, principal: "token", token: { id: 2, name: "admin" } })).toEqual({
            principal: "token",
            token: { id: 2, name: "admin" },
        });
    });
});
