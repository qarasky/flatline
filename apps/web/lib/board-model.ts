/**
 * Board model: the group tree with sorting, filtering and aggregates.
 *
 * Pure: no React, no DOM, so it is covered by node tests.
 */

import type { MonitorSummary } from "./monitor-types";
import { lastChangeMs, type Strip } from "./heartbeat-strip";

export type StatusKey = "up" | "down" | "pending" | "maintenance" | "paused";
export const STATUS_KEYS: StatusKey[] = ["down", "pending", "up", "maintenance", "paused"];

export type SortKey = "worst" | "name" | "uptime" | "changed";
export const SORT_KEYS: { key: SortKey; label: string }[] = [
    { key: "worst", label: "Worst first" },
    { key: "name", label: "Name" },
    { key: "uptime", label: "Uptime (lowest first)" },
    { key: "changed", label: "Last change" },
];

export interface FilterState {
    q: string;
    status: StatusKey[];
    types: string[];
    tags: string[];
    attention: boolean;
}

export const EMPTY_FILTER: FilterState = { q: "", status: [], types: [], tags: [], attention: false };

export function statusKeyOf(monitor: Pick<MonitorSummary, "active" | "status">): StatusKey {
    if (!monitor.active) {
        return "paused";
    }
    switch (monitor.status) {
        case 1:
            return "up";
        case 0:
            return "down";
        case 3:
            return "maintenance";
        default:
            return "pending";
    }
}

/** Lower is worse and sorts first. Paused sinks. */
export function statusRank(key: StatusKey): number {
    switch (key) {
        case "down":
            return 0;
        case "pending":
            return 1;
        case "maintenance":
            return 2;
        case "up":
            return 3;
        default:
            return 4;
    }
}

export function isFilterActive(filter: FilterState): boolean {
    return Boolean(
        filter.q.trim() || filter.status.length || filter.types.length || filter.tags.length || filter.attention
    );
}

/** Number of filters in force (the badge on the filter button; search is separate). */
export function activeFilterCount(filter: FilterState): number {
    return filter.status.length + filter.types.length + filter.tags.length + (filter.attention ? 1 : 0);
}

export interface Totals {
    total: number;
    up: number;
    down: number;
    pending: number;
    maintenance: number;
    paused: number;
}

function emptyTotals(): Totals {
    return { total: 0, up: 0, down: 0, pending: 0, maintenance: 0, paused: 0 };
}

export interface MonitorNode {
    kind: "monitor";
    id: number;
    monitor: MonitorSummary;
}

export interface GroupNode {
    kind: "group";
    id: number;
    monitor: MonitorSummary;
    children: BoardNode[];
    /** Whole subtree, before filtering. */
    totals: Totals;
    /** Worst status among active members, or "paused" when all are paused, "up" when empty. */
    worst: StatusKey;
}

export type BoardNode = MonitorNode | GroupNode;

export interface Board {
    roots: BoardNode[];
    ungrouped: MonitorNode[];
}

export interface BoardOptions {
    sort: SortKey;
    filter: FilterState;
    /** Monitors that need attention (for the "needs attention" preset). */
    attentionIds?: Set<number>;
    /** Sort keys come from this snapshot while the order is held. */
    basis?: Map<number, MonitorSummary>;
    strips?: Map<number, Strip>;
}

const byWeightName = (a: MonitorSummary, b: MonitorSummary): number =>
    (b.weight ?? 0) - (a.weight ?? 0) || a.name.localeCompare(b.name);

/** Worst-of for a set of statuses; paused members are ignored. */
export function worstOf(keys: StatusKey[]): StatusKey {
    const active = keys.filter((k) => k !== "paused");
    if (active.length === 0) {
        return keys.length ? "paused" : "up";
    }
    return active.reduce((worst, key) => (statusRank(key) < statusRank(worst) ? key : worst));
}

function matchesFilter(
    monitor: MonitorSummary,
    filter: FilterState,
    attentionIds: Set<number> | undefined,
    ancestorNameMatch: boolean
): boolean {
    if (filter.status.length && !filter.status.includes(statusKeyOf(monitor))) {
        return false;
    }
    if (filter.types.length && !filter.types.includes(monitor.type)) {
        return false;
    }
    if (filter.tags.length) {
        const names = (monitor.tags ?? []).map((t) => t.name);
        if (!filter.tags.some((tag) => names.includes(tag))) {
            return false;
        }
    }
    if (filter.attention && !(attentionIds?.has(monitor.id) ?? false)) {
        return false;
    }
    const needle = filter.q.trim().toLowerCase();
    if (needle && !ancestorNameMatch) {
        const hay = [monitor.name, monitor.url ?? "", monitor.hostname ?? "", monitor.type].join("\n").toLowerCase();
        if (!hay.includes(needle)) {
            return false;
        }
    }
    return true;
}

interface Built {
    node: BoardNode;
    keys: StatusKey[];
}

/**
 * Build the sorted, filtered tree.
 *
 * Anything whose parent is missing or not a group lands in `ungrouped`, so a
 * broken link can never hide a monitor. A group is kept when any descendant
 * matches the filter; a group whose own name matches the search keeps its
 * whole subtree for that part of the filter. Groups sort by their worst
 * descendant, so trouble rises.
 */
export function buildBoard(monitors: MonitorSummary[], options: BoardOptions): Board {
    const { sort, filter, attentionIds, basis, strips } = options;
    const live = (m: MonitorSummary) => basis?.get(m.id) ?? m;
    const needle = filter.q.trim().toLowerCase();

    const groups = monitors.filter((m) => m.type === "group");
    const groupIds = new Set(groups.map((g) => g.id));
    const childrenOf = new Map<number, MonitorSummary[]>();
    const rootGroups: MonitorSummary[] = [];
    const looseMonitors: MonitorSummary[] = [];
    for (const monitor of monitors) {
        if (monitor.parent != null && groupIds.has(monitor.parent) && monitor.parent !== monitor.id) {
            childrenOf.set(monitor.parent, [...(childrenOf.get(monitor.parent) ?? []), monitor]);
        } else if (monitor.type === "group") {
            rootGroups.push(monitor);
        } else {
            looseMonitors.push(monitor);
        }
    }

    // sort keys for any node (groups use their subtree)
    const sortKeyCache = new Map<number, { rank: number; uptime: number; changed: number }>();
    function memberKeys(monitor: MonitorSummary, seen: Set<number>): MonitorSummary[] {
        if (monitor.type !== "group") {
            return [monitor];
        }
        if (seen.has(monitor.id)) {
            return [];
        }
        seen.add(monitor.id);
        return (childrenOf.get(monitor.id) ?? []).flatMap((c) => memberKeys(c, seen));
    }
    function keysOf(monitor: MonitorSummary) {
        const cached = sortKeyCache.get(monitor.id);
        if (cached) {
            return cached;
        }
        const members = memberKeys(monitor, new Set()).map(live);
        const rank = members.length ? Math.min(...members.map((m) => statusRank(statusKeyOf(m)))) : statusRank("up");
        const uptimes = members.filter((m) => m.active && m.uptime24h != null).map((m) => m.uptime24h as number);
        const uptime = uptimes.length ? Math.min(...uptimes) : Infinity;
        const changes = members.map((m) => lastChangeMs(strips?.get(m.id))).filter((n): n is number => n !== null);
        const changed = changes.length ? Math.max(...changes) : -Infinity;
        const keys = { rank, uptime, changed };
        sortKeyCache.set(monitor.id, keys);
        return keys;
    }

    function compare(a: MonitorSummary, b: MonitorSummary): number {
        const aGroup = a.type === "group" ? 1 : 0;
        const bGroup = b.type === "group" ? 1 : 0;
        const ka = keysOf(a);
        const kb = keysOf(b);
        let primary = 0;
        switch (sort) {
            case "worst":
                // Worst first, mixed across kinds; ties fall back to monitors-before-groups.
                primary = ka.rank - kb.rank;
                break;
            case "uptime":
                primary = aGroup - bGroup || ka.uptime - kb.uptime || 0;
                break;
            case "changed":
                primary = aGroup - bGroup || kb.changed - ka.changed || 0;
                break;
            default:
                primary = aGroup - bGroup || a.name.localeCompare(b.name);
        }
        if (Number.isNaN(primary)) {
            primary = 0;
        }
        return primary || aGroup - bGroup || byWeightName(a, b);
    }

    function build(monitor: MonitorSummary, ancestorMatch: boolean, guard: number): Built | null {
        if (monitor.type !== "group") {
            if (!matchesFilter(monitor, filter, attentionIds, ancestorMatch)) {
                return null;
            }
            return { node: { kind: "monitor", id: monitor.id, monitor }, keys: [statusKeyOf(monitor)] };
        }
        if (guard > 12) {
            return null;
        }
        const nameMatch = ancestorMatch || (needle !== "" && monitor.name.toLowerCase().includes(needle));
        const kids = (childrenOf.get(monitor.id) ?? []).slice().sort(compare);
        const children: BoardNode[] = [];
        const keys: StatusKey[] = [];
        for (const kid of kids) {
            const built = build(kid, nameMatch, guard + 1);
            if (built) {
                children.push(built.node);
                keys.push(...built.keys);
            }
        }
        if (children.length === 0 && isFilterActive(filter)) {
            return null;
        }
        // Totals and worst-of come from the whole subtree so a filter does not change what a group says.
        const totals = emptyTotals();
        const all: StatusKey[] = [];
        for (const member of memberKeys(monitor, new Set())) {
            const key = statusKeyOf(member);
            totals.total++;
            totals[key]++;
            all.push(key);
        }
        return { node: { kind: "group", id: monitor.id, monitor, children, totals, worst: worstOf(all) }, keys };
    }

    const roots: BoardNode[] = [];
    for (const group of rootGroups.slice().sort(compare)) {
        const built = build(group, false, 0);
        if (built) {
            roots.push(built.node);
        }
    }
    const ungrouped: MonitorNode[] = [];
    for (const monitor of looseMonitors.slice().sort(compare)) {
        const built = build(monitor, false, 0);
        if (built && built.node.kind === "monitor") {
            ungrouped.push(built.node);
        }
    }
    return { roots, ungrouped };
}

/** Row ids in display order, for keyboard navigation (j/k). Collapsed groups hide their children. */
export function visibleRowIds(
    board: Board,
    collapsed: Set<number>,
    forceOpen: boolean
): { id: number; kind: "monitor" | "group" }[] {
    const out: { id: number; kind: "monitor" | "group" }[] = [];
    const walk = (nodes: BoardNode[]) => {
        for (const node of nodes) {
            out.push({ id: node.id, kind: node.kind });
            if (node.kind === "group" && (forceOpen || !collapsed.has(node.id))) {
                walk(node.children);
            }
        }
    };
    walk(board.roots);
    for (const node of board.ungrouped) {
        out.push({ id: node.id, kind: "monitor" });
    }
    return out;
}

/** Counts of real (non-group) monitors by status, for the summary banner. */
export function boardTotals(monitors: MonitorSummary[]): Totals {
    const totals = emptyTotals();
    for (const monitor of monitors) {
        if (monitor.type === "group") {
            continue;
        }
        totals.total++;
        totals[statusKeyOf(monitor)]++;
    }
    return totals;
}

/** Distinct monitor types and tag names present, for the filter popover. */
export function filterFacets(monitors: MonitorSummary[]): { types: string[]; tags: string[] } {
    const types = new Set<string>();
    const tags = new Set<string>();
    for (const monitor of monitors) {
        if (monitor.type !== "group") {
            types.add(monitor.type);
        }
        for (const tag of monitor.tags ?? []) {
            tags.add(tag.name);
        }
    }
    return { types: [...types].sort(), tags: [...tags].sort() };
}
