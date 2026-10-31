import type { Crumb } from "@/components/page-header";
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
