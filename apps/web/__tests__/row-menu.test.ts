import { describe, expect, it } from "vitest";

import type { MonitorSummary } from "@/lib/monitor-types";
import { groupMenuItems, monitorMenuItems } from "@/lib/row-menu";

function monitor(over: Partial<MonitorSummary>): MonitorSummary {
    return {
        id: 1,
        name: "m",
        type: "http",
        url: null,
        status: 1,
        ping: null,
        lastCheck: null,
        lastMessage: null,
        active: true,
        interval: 60,
        uptime24h: null,
        uptime7d: null,
        uptime30d: null,
        ...over,
    };
}

describe("monitorMenuItems", () => {
    it("offers Mute on a down monitor that is not muted", () => {
        const items = monitorMenuItems(monitor({ status: 0 }));
        expect(items).toContain("mute");
        expect(items).not.toContain("unmute");
    });

    it("offers Unmute when a mute covers it", () => {
        const items = monitorMenuItems(monitor({ status: 0, mutedBy: [5] }));
        expect(items).toContain("unmute");
        expect(items).not.toContain("mute");
    });

    it("offers Resume, not Pause, on a paused monitor", () => {
        const items = monitorMenuItems(monitor({ active: false }));
        expect(items).toContain("resume");
        expect(items).not.toContain("pause");
    });

    it("offers no Mute on an up monitor", () => {
        expect(monitorMenuItems(monitor({ status: 1 }))).not.toContain("mute");
    });

    it("starts with Open", () => {
        expect(monitorMenuItems(monitor({}))[0]).toBe("open");
    });
});

describe("groupMenuItems", () => {
    const group = monitor({ id: 9, type: "group" });

    it("has the group actions, with Mute while something inside is down", () => {
        expect(groupMenuItems(group, "down")).toEqual([
            "open",
            "edit",
            "newSubgroup",
            "rename",
            "move",
            "mute",
            "delete",
        ]);
    });

    it("leaves Mute out when nothing inside is down", () => {
        expect(groupMenuItems(group, "up")).toEqual(["open", "edit", "newSubgroup", "rename", "move", "delete"]);
    });

    it("offers Unmute when the group's mute is on", () => {
        const items = groupMenuItems({ ...group, mutedBy: [9] }, "down");
        expect(items).toContain("unmute");
        expect(items).not.toContain("mute");
    });
});
