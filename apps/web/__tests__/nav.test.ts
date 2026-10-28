import { describe, expect, it } from "vitest";

import { NAV_SECTIONS, activeSection } from "@/lib/nav";

describe("navigation", () => {
    it("lists the sections in the sidebar's order", () => {
        expect(NAV_SECTIONS.map((s) => [s.id, s.label, s.href])).toEqual([
            ["attention", "Attention", "/attention"],
            ["monitors", "Monitors", "/monitors"],
            ["servers", "Servers", "/servers"],
            ["backups", "Backups", "/backups"],
            ["notifications", "Notifications", "/notifications"],
            ["tokens", "Tokens", "/tokens"],
            ["superboard", "Superboard", "/superboard"],
        ]);
    });

    it("opens the Superboard as its own page", () => {
        expect(NAV_SECTIONS.find((s) => s.id === "superboard")?.external).toBe(true);
    });

    it("marks the section a path belongs to", () => {
        expect(activeSection("/monitors")).toBe("monitors");
        expect(activeSection("/monitors/12")).toBe("monitors");
        expect(activeSection("/servers?x=1")).toBe("servers");
        expect(activeSection("/monitorsx")).toBeNull();
        expect(activeSection("/sign-in")).toBeNull();
    });
});
