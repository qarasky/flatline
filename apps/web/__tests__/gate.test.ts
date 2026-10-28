import { describe, expect, it } from "vitest";

import { gate } from "@/lib/gate";

describe("gate", () => {
    it("sends a signed-out visitor to sign-in with the way back", () => {
        expect(gate("/monitors", "?status=down", false)).toEqual({
            kind: "redirect",
            to: "/sign-in?next=%2Fmonitors%3Fstatus%3Ddown",
        });
    });

    it("lets a signed-in operator through", () => {
        expect(gate("/monitors", "", true)).toEqual({ kind: "next" });
    });

    it("sends a signed-in operator away from sign-in", () => {
        expect(gate("/sign-in", "?next=%2Fservers", true)).toEqual({ kind: "redirect", to: "/servers" });
    });

    it("keeps an expired session on sign-in instead of looping", () => {
        expect(gate("/sign-in", "?expired=1&next=%2Fservers", true)).toEqual({ kind: "next" });
    });

    it("shows sign-in to a signed-out visitor", () => {
        expect(gate("/sign-in", "", false)).toEqual({ kind: "next" });
    });

    it("sends the root to the monitors", () => {
        expect(gate("/", "", true)).toEqual({ kind: "redirect", to: "/monitors" });
    });
});
