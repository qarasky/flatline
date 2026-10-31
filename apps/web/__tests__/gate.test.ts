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

    it("opens the old dashboard's ?m= link on the monitor's own page", () => {
        expect(gate("/", "?m=12", true)).toEqual({ kind: "redirect", to: "/monitors/12" });
    });

    it("drops an ?m= that is not a monitor id", () => {
        expect(gate("/", "?m=abc", true)).toEqual({ kind: "redirect", to: "/monitors" });
    });

    it("carries the old board's filters over to Monitors", () => {
        expect(gate("/", "?status=down&sort=name&m=", true)).toEqual({
            kind: "redirect",
            to: "/monitors?status=down&sort=name",
        });
    });

    it("leaves anything that is not board state behind", () => {
        expect(gate("/", "?foo=1", true)).toEqual({ kind: "redirect", to: "/monitors" });
    });

    it("lets a signed-out visitor reach the root, where a client's status domain resolves", () => {
        expect(gate("/", "?m=12", false)).toEqual({ kind: "next" });
    });

    it("drops an ?m= too large to be a monitor id", () => {
        expect(gate("/", "?m=99999999999999999999", true)).toEqual({ kind: "redirect", to: "/monitors" });
    });

    it("lets a signed-out wall screen reach the kiosk, which shows its QR", () => {
        expect(gate("/superboard/kiosk", "", false)).toEqual({ kind: "next" });
        expect(gate("/superboard/kiosk/work,home", "?rotate=30", false)).toEqual({ kind: "next" });
    });

    it("keeps status pages, the approve page and the build id public", () => {
        expect(gate("/status/acme", "", false)).toEqual({ kind: "next" });
        expect(gate("/device", "", false)).toEqual({ kind: "next" });
        expect(gate("/build", "", false)).toEqual({ kind: "next" });
    });

    it("sends a signed-out desk Superboard to sign-in", () => {
        expect(gate("/superboard", "", false)).toEqual({ kind: "redirect", to: "/sign-in?next=%2Fsuperboard" });
        expect(gate("/superboard/work", "", false)).toEqual({
            kind: "redirect",
            to: "/sign-in?next=%2Fsuperboard%2Fwork",
        });
    });

    it("does not mistake a lookalike path for a public one", () => {
        expect(gate("/statusx", "", false).kind).toBe("redirect");
        expect(gate("/superboard/kioskish", "", false).kind).toBe("redirect");
    });
});
