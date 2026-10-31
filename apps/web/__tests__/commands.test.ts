import { describe, expect, it } from "vitest";

import { buildCommands } from "@/lib/commands";
import type { Me } from "@/lib/me";
import type { MonitorSummary } from "@/lib/monitor-types";
import { NAV_SECTIONS } from "@/lib/nav";

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

const account: Me = {
    principal: "account",
    account: { id: 1, email: "a@b.kz", name: "Ana", mustChangePassword: false },
};
const token: Me = { principal: "token", token: { id: 1, name: "wall tv" } };

const roster = [
    monitor({ id: 1, name: "Work", type: "group" }),
    monitor({ id: 2, name: "api.kz", url: "https://api.kz/health", parent: 1 }),
    monitor({ id: 3, name: "db-01", type: "push", parent: 1 }),
];

const group = (heading: string, me: Me = account) =>
    buildCommands(roster, me).find((g) => g.heading === heading)?.commands ?? [];

describe("buildCommands", () => {
    it("lists sections first, every one of them", () => {
        const groups = buildCommands(roster, account);
        expect(groups[0].heading).toBe("Sections");
        expect(groups[0].commands.map((c) => c.href)).toEqual(NAV_SECTIONS.map((s) => s.href));
    });

    it("puts push monitors under Servers, not Monitors", () => {
        expect(group("Servers").map((c) => c.label)).toEqual(["db-01"]);
        expect(group("Monitors").map((c) => c.label)).not.toContain("db-01");
    });

    it("lists groups with the monitors", () => {
        expect(group("Monitors").map((c) => c.label)).toContain("Work");
    });

    it("opens a monitor's own page", () => {
        expect(group("Monitors").find((c) => c.label === "api.kz")?.href).toBe("/monitors/2");
    });

    it("finds a monitor by its url and its group", () => {
        const keywords = group("Monitors").find((c) => c.label === "api.kz")?.keywords ?? [];
        expect(keywords).toContain("https://api.kz/health");
        expect(keywords).toContain("Work");
    });

    it("offers Change password to an account only", () => {
        expect(group("Actions").map((c) => c.id)).toContain("change-password");
        expect(group("Actions", token).map((c) => c.id)).not.toContain("change-password");
    });

    it("always offers New monitor and Sign out", () => {
        const ids = group("Actions", token).map((c) => c.id);
        expect(ids).toContain("new-monitor");
        expect(ids).toContain("sign-out");
    });

    it("opens a server on its Servers page", () => {
        expect(group("Servers").find((c) => c.label === "db-01")?.href).toBe("/servers/3");
    });
});
