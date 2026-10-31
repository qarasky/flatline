/**
 * Helpers for server -> website links: picker candidates and card chips.
 *
 * A server is a monitor that emits metrics (usually `push`). Its linked
 * targets are websites, or groups containing them; the server expands groups
 * to their websites when it resolves the links, so the dashboard only builds
 * picker candidates and orders the chips. Only HTTP/HTTPS monitors count as
 * websites: other servers and ping checks are never offered as a target.
 */

import type { MonitorSummary, ResolvedMonitorLink } from "./monitor-types";
import { groupPath } from "./groups";

export interface LinkCandidate {
    id: number;
    label: string;
    kind: "group" | "monitor";
    /** Current status of the candidate, shown as a dot in the picker. */
    status: number;
}

/** Monitor types that count as a hosted website. */
const WEBSITE_TYPES = new Set(["http", "https"]);

/** Whether a monitor is a website that a server card can link. */
export function isWebsiteMonitor(monitor: Pick<MonitorSummary, "type">): boolean {
    return WEBSITE_TYPES.has(monitor.type);
}

/**
 * Picker options for a server: every group holding a website somewhere below
 * it, and every website, excluding the server itself. Groups come first so
 * "link a whole group" reads as a distinct choice from "link one website".
 * @param monitors Full roster
 * @param excludeId The server being edited, never offered as a target
 * @returns Candidates, groups then websites, each sorted by label
 */
export function buildLinkCandidates(monitors: MonitorSummary[], excludeId?: number | null): LinkCandidate[] {
    const childrenOf = new Map<number, MonitorSummary[]>();
    for (const monitor of monitors) {
        if (monitor.parent === null || monitor.parent === undefined) {
            continue;
        }
        const siblings = childrenOf.get(monitor.parent);
        if (siblings) {
            siblings.push(monitor);
        } else {
            childrenOf.set(monitor.parent, [monitor]);
        }
    }

    // A group is only worth offering when it actually contains a website, so
    // a group of servers can't be picked as a website link.
    const holdsWebsite = (id: number, seen = new Set<number>()): boolean => {
        if (!seen.add(id)) {
            return false;
        }
        return (childrenOf.get(id) ?? []).some(
            (child) => isWebsiteMonitor(child) || (child.type === "group" && holdsWebsite(child.id, seen))
        );
    };

    const groups: LinkCandidate[] = monitors
        .filter((m) => m.type === "group" && m.id !== excludeId && holdsWebsite(m.id))
        .map((m) => ({ id: m.id, label: groupPath(monitors, m.id) ?? m.name, kind: "group", status: m.status }));
    const singles: LinkCandidate[] = monitors
        .filter((m) => isWebsiteMonitor(m) && m.id !== excludeId)
        .map((m) => ({ id: m.id, label: m.name, kind: "monitor", status: m.status }));

    groups.sort((a, b) => a.label.localeCompare(b.label));
    singles.sort((a, b) => a.label.localeCompare(b.label));
    return [...groups, ...singles];
}

/** Worst-first order: down, pending, maintenance, up, then unknown. */
const LINK_ORDER: Record<number, number> = { 0: 0, 2: 1, 3: 2, 1: 3 };

/**
 * Sort linked websites worst-first so a problem never hides below a healthy
 * chip, with name as a stable tiebreaker.
 * @param links Resolved links
 * @returns A new, sorted array
 */
export function sortLinks(links: ResolvedMonitorLink[]): ResolvedMonitorLink[] {
    return [...links].sort(
        (a, b) => (LINK_ORDER[a.status] ?? 4) - (LINK_ORDER[b.status] ?? 4) || a.name.localeCompare(b.name)
    );
}

export function linkStatusLabel(status: number): string {
    switch (status) {
        case 1:
            return "Up";
        case 0:
            return "Down";
        case 2:
            return "Pending";
        case 3:
            return "Maintenance";
        default:
            return "Unknown";
    }
}

export function linkTone(status: number): "up" | "bad" | "pending" | "maintenance" | "neutral" {
    switch (status) {
        case 1:
            return "up";
        case 0:
            return "bad";
        case 2:
            return "pending";
        case 3:
            return "maintenance";
        default:
            return "neutral";
    }
}
