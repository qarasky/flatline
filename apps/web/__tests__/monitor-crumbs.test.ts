import { describe, expect, it } from "vitest";

import { monitorCrumbs } from "@/lib/monitor-crumbs";

const roster = [
    { id: 1, name: "Clients", parent: null },
    { id: 2, name: "Work", parent: 1 },
    { id: 3, name: "api.kz", parent: 2 },
];

describe("monitorCrumbs", () => {
    it("walks a monitor up through its groups", () => {
        expect(monitorCrumbs(roster, 3)).toEqual([
            { label: "Monitors", href: "/monitors" },
            { label: "Clients", href: "/monitors/1" },
            { label: "Work", href: "/monitors/2" },
            { label: "api.kz" },
        ]);
    });

    it("stops at a parent cycle", () => {
        const cycle = [
            { id: 1, name: "A", parent: 2 },
            { id: 2, name: "B", parent: 1 },
        ];
        expect(monitorCrumbs(cycle, 1)).toEqual([
            { label: "Monitors", href: "/monitors" },
            { label: "B", href: "/monitors/2" },
            { label: "A" },
        ]);
    });

    it("leaves out a parent that is not in the roster", () => {
        expect(monitorCrumbs([{ id: 5, name: "lone", parent: 99 }], 5)).toEqual([
            { label: "Monitors", href: "/monitors" },
            { label: "lone" },
        ]);
    });

    it("gives just Monitors for an unknown id", () => {
        expect(monitorCrumbs(roster, 42)).toEqual([{ label: "Monitors", href: "/monitors" }]);
    });
});
