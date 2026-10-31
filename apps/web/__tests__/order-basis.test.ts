import { describe, expect, it } from "vitest";

import type { MonitorSummary } from "@/lib/monitor-types";
import { orderBasis } from "@/lib/order-basis";

function monitor(id: number, status: number, active = true): MonitorSummary {
    return {
        id,
        name: `m${id}`,
        type: "http",
        url: null,
        status,
        ping: null,
        lastCheck: null,
        lastMessage: null,
        active,
        interval: 60,
        uptime24h: null,
        uptime7d: null,
        uptime30d: null,
    };
}

const map = (...monitors: MonitorSummary[]) => new Map(monitors.map((m) => [m.id, m]));

describe("orderBasis", () => {
    it("holding keeps the old status for sorting", () => {
        const basis = orderBasis(map(monitor(1, 0)), [monitor(1, 1)], true);
        expect(basis.get(1)?.status).toBe(0);
    });

    it("holding keeps the old paused state too", () => {
        const basis = orderBasis(map(monitor(1, 1, false)), [monitor(1, 1, true)], true);
        expect(basis.get(1)?.active).toBe(false);
    });

    it("holding keeps the old uptime, the third sort key", () => {
        const basis = orderBasis(
            map({ ...monitor(1, 1), uptime24h: 0.5 }),
            [{ ...monitor(1, 1), uptime24h: 0.9 }],
            true
        );
        expect(basis.get(1)?.uptime24h).toBe(0.5);
    });

    it("a new monitor joins the held basis", () => {
        const basis = orderBasis(map(monitor(1, 0)), [monitor(1, 1), monitor(2, 1)], true);
        expect(basis.get(2)?.status).toBe(1);
    });

    it("a deleted monitor leaves it", () => {
        const basis = orderBasis(map(monitor(1, 0), monitor(2, 0)), [monitor(1, 1)], true);
        expect(basis.has(2)).toBe(false);
    });

    it("not holding returns the live roster", () => {
        const basis = orderBasis(map(monitor(1, 0)), [monitor(1, 1)], false);
        expect(basis.get(1)?.status).toBe(1);
    });

    it("holding keeps live names and the rest: only the sort keys stay", () => {
        const renamed = { ...monitor(1, 1), name: "renamed" };
        const basis = orderBasis(map(monitor(1, 0)), [renamed], true);
        expect(basis.get(1)?.name).toBe("renamed");
    });
});
