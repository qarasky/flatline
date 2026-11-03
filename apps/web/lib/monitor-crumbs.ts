/** One breadcrumb (kore-ui's `Crumb`, with a text label). */
export interface Crumb {
    label: string;
    href?: string;
}

import type { MonitorSummary } from "@/lib/monitor-types";

/**
 * Breadcrumbs for a monitor's own page: Monitors, then its groups from the
 * top down (each a link), then the monitor. A parent cycle stops the walk;
 * a parent missing from the roster is left out.
 */
export function monitorCrumbs(monitors: Pick<MonitorSummary, "id" | "name" | "parent">[], id: number): Crumb[] {
    const root: Crumb = { label: "Monitors", href: "/monitors" };
    const byId = new Map(monitors.map((m) => [m.id, m]));
    const monitor = byId.get(id);
    if (!monitor) {
        return [root];
    }
    const groups: Crumb[] = [];
    const seen = new Set([id]);
    let parent = monitor.parent ?? null;
    while (parent !== null && !seen.has(parent)) {
        const group = byId.get(parent);
        if (!group) {
            break;
        }
        seen.add(parent);
        groups.unshift({ label: group.name, href: `/monitors/${group.id}` });
        parent = group.parent ?? null;
    }
    return [root, ...groups, { label: monitor.name }];
}

/** PageHeader props for a monitor's page: the groups as breadcrumbs, the monitor as the title. */
export function monitorHeader(
    monitors: Pick<MonitorSummary, "id" | "name" | "parent">[],
    id: number
): { breadcrumbs: Crumb[]; title: string } {
    const crumbs = monitorCrumbs(monitors, id);
    const last = crumbs[crumbs.length - 1]!;
    return { breadcrumbs: crumbs.slice(0, -1), title: last.href ? "Monitor" : last.label };
}
