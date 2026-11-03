import { describe, expect, it } from "vitest";

import { displayName, toMe } from "@/lib/me";

describe("displayName", () => {
    it("names an account by its name", () => {
        expect(
            displayName({
                principal: "account",
                account: { id: 1, email: "a@x.kz", name: "Ana Bek", mustChangePassword: false, sso: false },
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
            account: { id: 1, email: "a@x.kz", name: "Ana", mustChangePassword: true, sso: false },
        });
        expect(toMe({ ok: true, principal: "token", token: { id: 2, name: "admin" } })).toEqual({
            principal: "token",
            token: { id: 2, name: "admin" },
        });
    });
});
