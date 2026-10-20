/**
 * Group-tree helpers shared by the monitor table, the group dialogs and the
 * monitor form's Group picker.
 *
 * The API stores a group as a monitor with `type: "group"` and children
 * pointing at it through `parent`. These helpers turn that flat list into
 * paths, subtree sets and picker options without duplicating the tree logic
 * that lives in components/Dashboard.tsx.
 */

import type { MonitorSummary } from "./api";

/** How deep a parent chain is walked before giving up on a cycle. */
const MAX_DEPTH = 64;

/**
 * Full path of a group, outermost first: "work / nationalbusiness.kz".
 * `null` when the id is missing, not a group, or the chain is broken.
 * @param monitors Full roster
 * @param id Group monitor id
 * @returns Path string, or null
 */
export function groupPath(monitors: MonitorSummary[], id: number | null | undefined): string | null {
    if (id == null) {
        return null;
    }
    const groups = new Map(monitors.filter((m) => m.type === "group").map((m) => [m.id, m]));
    const names: string[] = [];
    let cursor: number | null | undefined = id;
    for (let depth = 0; depth < MAX_DEPTH && cursor != null; depth++) {
        const group = groups.get(cursor);
        if (!group) {
            break;
        }
        names.unshift(group.name);
        cursor = group.parent;
    }
    return names.length ? names.join(" / ") : null;
}

/**
 * A group plus every group nested inside it, including itself.
 * Used to keep a group out of its own "move to group" options.
 * @param monitors Full roster
 * @param id Group monitor id
 * @returns Ids of the subtree
 */
export function descendantGroupIds(monitors: MonitorSummary[], id: number): Set<number> {
    const children = new Map<number, number[]>();
    for (const monitor of monitors) {
        if (monitor.type !== "group" || monitor.parent == null) {
            continue;
        }
        children.set(monitor.parent, [...(children.get(monitor.parent) ?? []), monitor.id]);
    }

    const seen = new Set<number>([id]);
    const stack = [id];
    while (stack.length) {
        const current = stack.pop() as number;
        for (const child of children.get(current) ?? []) {
            if (!seen.has(child)) {
                seen.add(child);
                stack.push(child);
            }
        }
    }
    return seen;
}

export interface GroupOption {
    value: string;
    label: string;
}

/**
 * Options for a Group picker: every group by full path, sorted, excluding a
 * subtree when a group is being edited (a group cannot move inside itself).
 * @param monitors Full roster
 * @param excludeSubtreeOf Group whose subtree must not appear
 * @returns Select options
 */
export function groupOptions(monitors: MonitorSummary[], excludeSubtreeOf?: number | null): GroupOption[] {
    const excluded = excludeSubtreeOf != null ? descendantGroupIds(monitors, excludeSubtreeOf) : new Set<number>();
    return monitors
        .filter((m) => m.type === "group" && !excluded.has(m.id))
        .map((m) => ({ value: String(m.id), label: groupPath(monitors, m.id) ?? m.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Number of non-group monitors inside a group's whole subtree.
 * @param monitors Full roster
 * @param id Group monitor id
 * @returns Monitor count
 */
export function subtreeMonitorCount(monitors: MonitorSummary[], id: number): number {
    const subtree = descendantGroupIds(monitors, id);
    return monitors.filter((m) => m.type !== "group" && m.parent != null && subtree.has(m.parent)).length;
}

/**
 * Direct children of a group: groups and monitors alike.
 * @param monitors Full roster
 * @param id Group monitor id
 * @returns Child monitors
 */
export function directChildren(monitors: MonitorSummary[], id: number): MonitorSummary[] {
    return monitors.filter((m) => m.parent === id);
}
