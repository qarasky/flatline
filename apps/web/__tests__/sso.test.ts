import { describe, expect, it } from "vitest";

import { ssoErrorMessage, ssoStartHref, toMethods } from "@/lib/sso";

describe("sign-in methods", () => {
    it("defaults to the local methods for an old backend", () => {
        expect(toMethods({ ok: true })).toEqual({ sso: false, localLogin: true, tokenLogin: true });
    });
    it("reads the switches", () => {
        expect(toMethods({ sso: true, localLogin: false, tokenLogin: false })).toEqual({
            sso: true,
            localLogin: false,
            tokenLogin: false,
        });
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
        expect(ssoErrorMessage("denied")).toMatch(/not allowed/);
        expect(ssoErrorMessage("whatever")).toMatch(/failed/);
        expect(ssoErrorMessage(null)).toBeNull();
    });
});
