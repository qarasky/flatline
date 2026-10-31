import { groupPath } from "@/lib/groups";
import type { Me } from "@/lib/me";
import type { MonitorSummary } from "@/lib/monitor-types";
import { NAV_SECTIONS } from "@/lib/nav";
import { PASSWORD_PATH } from "@/lib/session";

export interface Command {
    id: string;
    label: string;
    /** Where it goes; "" for an action the palette runs itself (Sign out). */
    href: string;
    /** Extra text the palette's search matches. */
    keywords: string[];
}

export interface CommandGroup {
    heading: "Sections" | "Monitors" | "Servers" | "Actions";
    commands: Command[];
}

/**
 * What ⌘K offers, in order: the sections, every monitor and group, the
 * servers (push monitors, which report metrics) and the main actions.
 * Monitors open their own page and servers their Servers page.
 */
export function buildCommands(monitors: MonitorSummary[], me: Me): CommandGroup[] {
    const entry = (m: MonitorSummary): Command => ({
        id: `monitor-${m.id}`,
        label: m.name,
        href: m.type === "push" ? `/servers/${m.id}` : `/monitors/${m.id}`,
        keywords: [m.url, m.hostname, groupPath(monitors, m.parent), m.type].filter(
            (k): k is string => typeof k === "string" && k !== ""
        ),
    });
    const byName = (a: MonitorSummary, b: MonitorSummary) => a.name.localeCompare(b.name);
    const actions: Command[] = [
        { id: "new-monitor", label: "New monitor", href: "/monitors?new=1", keywords: ["create", "add"] },
        { id: "superboard", label: "Open Superboard", href: "/superboard", keywords: ["wall", "kiosk"] },
    ];
    if (me.principal === "account") {
        actions.push({ id: "change-password", label: "Change password", href: PASSWORD_PATH, keywords: ["account"] });
    }
    actions.push({ id: "sign-out", label: "Sign out", href: "", keywords: ["log out"] });

    return [
        {
            heading: "Sections",
            commands: NAV_SECTIONS.map((s) => ({ id: `section-${s.id}`, label: s.label, href: s.href, keywords: [] })),
        },
        {
            heading: "Monitors",
            commands: monitors
                .filter((m) => m.type !== "push")
                .sort(byName)
                .map(entry),
        },
        {
            heading: "Servers",
            commands: monitors
                .filter((m) => m.type === "push")
                .sort(byName)
                .map(entry),
        },
        { heading: "Actions", commands: actions },
    ];
}
