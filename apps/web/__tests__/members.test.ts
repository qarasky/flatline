import { describe, expect, it } from "vitest";

import { type Member, removalWarning } from "@/lib/members";

const base = {
    id: 1,
    email: "a@x.kz",
    name: "Ana",
    createdAt: "2026-10-28 10:00:00",
    tokenCount: 0,
    sso: true,
} satisfies Member;

describe("removalWarning", () => {
    it("explains that the last account is re-provisioned by Kore ID", () => {
        expect(removalWarning([base], 1)).toMatch(/last account/);
        expect(removalWarning([base], 1)).toMatch(/Kore ID/);
    });

    it("says nothing while other accounts remain", () => {
        expect(removalWarning([base, { ...base, id: 2 }], 1)).toBeNull();
    });
});
