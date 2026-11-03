import { describe, expect, it } from "vitest";

import { ssoErrorMessage, ssoStartHref, toMethods } from "@/lib/sso";

describe("sign-in methods", () => {
    it("defaults to the local methods for an old backend", () => {
        expect(toMethods({ ok: true })).toEqual({
            sso: false,
            localLogin: true,
            tokenLogin: true,
            accountUrl: null,
            apps: {},
        });
    });
    it("reads the switches", () => {
        expect(toMethods({ sso: true, localLogin: false, tokenLogin: false })).toEqual({
            sso: true,
            localLogin: false,
            tokenLogin: false,
            accountUrl: null,
            apps: {},
        });
    });
    it("keeps the Kore ID account page and known http(s) app URLs only", () => {
        const methods = toMethods({
            sso: true,
            accountUrl: "https://id.example/account",
            apps: { kore: "https://files.example", koremind: "javascript:alert(1)", other: "https://x.example" },
        });
        expect(methods.accountUrl).toBe("https://id.example/account");
        expect(methods.apps).toEqual({ kore: "https://files.example" });
        expect(toMethods({ accountUrl: "javascript:alert(1)" }).accountUrl).toBeNull();
    });
});

describe("ssoStartHref", () => {
    it("passes a local next path along, encoded", () => {
        expect(ssoStartHref("/monitors?a=1&b=2")).toBe("/api/v1/auth/sso/start?next=%2Fmonitors%3Fa%3D1%26b%3D2");
    });
    it("drops anything that is not a path", () => {
        expect(ssoStartHref("https://evil.example")).toBe("/api/v1/auth/sso/start");
        expect(ssoStartHref(null)).toBe("/api/v1/auth/sso/start");
    });
});

describe("ssoErrorMessage", () => {
    it("explains known codes and falls back for unknown ones", () => {
        expect(ssoErrorMessage("denied")).toMatch(/access/);
        expect(ssoErrorMessage("whatever")).toMatch(/failed/);
        expect(ssoErrorMessage(null)).toBeNull();
    });
});
