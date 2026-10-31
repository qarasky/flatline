import { describe, expect, it } from "vitest";

import { expiresAt, tokenRow, type TokenKey } from "@/lib/token-row";
import type { Me } from "@/lib/me";

const now = Date.parse("2026-10-31T12:00:00Z");
const key = (over: Partial<TokenKey> = {}): TokenKey => ({
    id: 4,
    name: "laptop",
    createdDate: "2026-10-01 08:00:00",
    active: true,
    expires: null,
    lastUsedAt: null,
    maker: { id: 2, name: "Ana", removed: false },
    ...over,
});
const asToken = (id: number): Me => ({ principal: "token", token: { id, name: "x" } });
const asAccount: Me = {
    principal: "account",
    account: { id: 2, email: "a@x", name: "Ana", mustChangePassword: false },
};

describe("tokenRow", () => {
    it("is active, never used and made by its maker", () => {
        expect(tokenRow(key(), asAccount, now)).toEqual({
            status: "active",
            lastUsed: "never",
            maker: "Ana",
            expires: "never",
            isCurrent: false,
        });
    });

    it("says disabled for an inactive token and expired once past its expiry", () => {
        expect(tokenRow(key({ active: false }), asAccount, now).status).toBe("disabled");
        expect(tokenRow(key({ expires: "2026-10-30T00:00:00Z" }), asAccount, now).status).toBe("expired");
        // Expired wins over disabled: re-enabling would not bring it back.
        expect(tokenRow(key({ active: false, expires: "2026-10-30 00:00:00" }), asAccount, now).status).toBe("expired");
    });

    it("shows how long ago it was used", () => {
        expect(tokenRow(key({ lastUsedAt: "2026-10-31 11:57:00" }), asAccount, now).lastUsed).toBe("3m ago");
    });

    it("names a removed maker, and no maker for tokens from before accounts", () => {
        expect(tokenRow(key({ maker: { id: null, name: "Ana", removed: true } }), asAccount, now).maker).toBe(
            "removed member Ana"
        );
        expect(tokenRow(key({ maker: null }), asAccount, now).maker).toBe("—");
    });

    it("is current only for the token this browser signed in with", () => {
        expect(tokenRow(key(), asToken(4), now).isCurrent).toBe(true);
        expect(tokenRow(key(), asToken(5), now).isCurrent).toBe(false);
        expect(tokenRow(key(), asAccount, now).isCurrent).toBe(false);
    });

    it("shows the expiry date", () => {
        expect(tokenRow(key({ expires: "2026-12-01T00:00:00Z" }), asAccount, now).expires).toBe("2026-12-01");
    });
});

describe("expiresAt", () => {
    it("is undefined for never and an ISO time otherwise", () => {
        expect(expiresAt("never", now)).toBeUndefined();
        expect(expiresAt("30d", now)).toBe("2026-11-30T12:00:00.000Z");
        expect(expiresAt("1y", now)).toBe("2027-10-31T12:00:00.000Z");
    });
});
