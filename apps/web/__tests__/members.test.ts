import { describe, expect, it } from "vitest";

import { type Member, memberStatus, removalWarning } from "@/lib/members";

const base = {
    id: 1,
    email: "a@x.kz",
    name: "Ana",
    createdAt: "2026-10-28 10:00:00",
    tokenCount: 0,
    mustChangePassword: false,
    startingPasswordExpired: false,
} satisfies Member;

describe("memberStatus", () => {
    it("is active once the member chose their own password", () => {
        expect(memberStatus(base)).toBe("active");
    });

    it("awaits the first sign-in while the starting password is fresh", () => {
        expect(memberStatus({ ...base, mustChangePassword: true })).toBe("awaiting-first-sign-in");
    });

    it("needs a reset once the starting password expired", () => {
        expect(memberStatus({ ...base, mustChangePassword: true, startingPasswordExpired: true })).toBe("needs-reset");
    });
});

describe("removalWarning", () => {
    it("warns before removing the last account", () => {
        expect(removalWarning([base], 1)).toMatch(/last account/);
    });

    it("says nothing while other accounts remain", () => {
        expect(removalWarning([base, { ...base, id: 2 }], 1)).toBeNull();
    });
});
