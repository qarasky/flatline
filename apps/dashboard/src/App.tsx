import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ApiError,
    deleteMonitor,
    fetchAllMonitors,
    updateMonitor,
    watchLive,
    getToken,
    pauseMonitor,
    resumeMonitor,
    setToken,
    type HealthSummary,
    type MonitorSummary,
} from "@/lib/api";
import { MonitorForm } from "@/components/MonitorForm";
import { MonitorDetail } from "@/components/MonitorDetail";
import {
    DeleteGroupDialog,
    MoveDialog,
    RenameDialog,
    ServerMenu,
    type MenuAnchor,
    type MenuItem,
} from "@/components/ServerMenu";
import { directChildren, groupOptions, groupPath, subtreeMonitorCount } from "@/lib/groups";
import { buildLinkCandidates } from "@/lib/links";
import { AgentPanel } from "@/components/AgentPanel";
import { TokenGate } from "@/components/TokenGate";
import { SuperboardApp } from "@/components/Superboard";
import { navigate, usePath } from "@/lib/router";
import { boardRouteFrom, statusSlugFromPath } from "@/lib/fleet-presentation";
import { StatusPageApp } from "@/components/status/StatusPageApp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { healthFromMonitors } from "@/lib/live-state";

/**
 * Map a numeric monitor status onto a label and a badge tone.
 *
 * Status is never colour alone; a word always accompanies it.
 */
function statusOf(status: number): { label: string; tone: "up" | "down" | "degraded" | "maintenance" | "neutral" } {
    switch (status) {
        case 1:
            return { label: "Up", tone: "up" };
        case 0:
            return { label: "Down", tone: "down" };
        case 2:
            return { label: "Pending", tone: "degraded" };
        case 3:
            return { label: "Maintenance", tone: "maintenance" };
        default:
            return { label: "Unknown", tone: "neutral" };
    }
}

function formatUptime(value: number | null): string {
    if (value === null || value === undefined) {
        return "—";
    }
    // The API returns a 0..1 ratio.
    return `${(value * 100).toFixed(value >= 0.9999 ? 2 : 1)}%`;
}

function formatPing(value: number | null): string {
    return value === null || value === undefined ? "—" : `${Math.round(value)}ms`;
}

/**
 * Relative age of a timestamp, e.g. "12s".
 */
function ageOf(value: string | null): string {
    if (!value) {
        return "—";
    }

    const then = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z")).getTime();
    if (Number.isNaN(then)) {
        return "—";
    }

    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.round(seconds / 60)}m`;
    }
    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)}h`;
    }
    return `${Math.round(seconds / 86400)}d`;
}

/**
 * One-line health strip.
 *
 * Dense on purpose: the operator's question is "is anything broken", and it
 * should be answerable without reading five equal-weight cards.
 */
function HealthStrip({ health }: { health: HealthSummary }) {
    const items: Array<{ label: string; value: number; tone: string }> = [
        { label: "up", value: health.up, tone: "text-ok" },
        { label: "down", value: health.down, tone: health.down > 0 ? "text-bad font-semibold" : "text-quiet" },
        { label: "pending", value: health.pending, tone: health.pending > 0 ? "text-warn" : "text-quiet" },
        { label: "maintenance", value: health.maintenance, tone: health.maintenance > 0 ? "text-maint" : "text-quiet" },
        { label: "paused", value: health.paused, tone: "text-quiet" },
    ];

    return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-3">
            <span
                className={`inline-flex items-center gap-2 text-sm font-semibold ${
                    health.down > 0 ? "text-bad" : "text-ok"
                }`}
            >
                <span className="size-2 rounded-full bg-current" />
                {health.down > 0 ? "Degraded" : "Operational"}
            </span>

            {items.map((item) => (
                <span key={item.label} className="text-xs">
                    <span className={`tnum font-semibold ${item.tone}`}>{item.value}</span>{" "}
                    <span className="text-quiet">{item.label}</span>
                </span>
            ))}

            <span className="ml-auto text-xs text-quiet">
                <span className="tnum">{health.total}</span> monitors
            </span>
        </div>
    );
}

/**
 * Sort key for roster order: heavier floats up, ties break by name so the
 * list never reshuffles between refreshes. Matches the server's canonical
 * ordering (weight DESC, name).
 */
function byWeightThenName(a: MonitorSummary, b: MonitorSummary): number {
    return (b.weight ?? 0) - (a.weight ?? 0) || a.name.localeCompare(b.name);
}

/**
 * One node of the group tree: a group, its subgroups and its direct monitors.
 *
 * Groups nest: a group whose `parent` is another group becomes its child, so
 * the operator can model "client → site → monitors" without flattening it.
 * Group monitors never render as rows themselves.
 */
interface GroupNode {
    id: number;
    name: string;
    weight: number;
    groups: GroupNode[];
    monitors: MonitorSummary[];
    /** The group monitor itself, for menus and dialogs. */
    group: MonitorSummary;
}

/**
 * Build the group tree from the roster.
 *
 * Anything whose parent is missing or not a group lands in Ungrouped, so a
 * broken link can never hide a monitor.
 * @param monitors Full roster
 * @returns Root groups plus parentless monitors
 */
function groupTree(monitors: MonitorSummary[]): { roots: GroupNode[]; ungrouped: MonitorSummary[] } {
    const groups = monitors.filter((m) => m.type === "group");
    const nodes = new Map<number, GroupNode>(
        groups.map((group) => [
            group.id,
            { id: group.id, name: group.name, weight: group.weight ?? 0, groups: [], monitors: [], group },
        ])
    );

    const roots: GroupNode[] = [];
    for (const group of groups) {
        const node = nodes.get(group.id) as GroupNode;
        const parent = group.parent != null ? nodes.get(group.parent) : undefined;
        if (parent) {
            parent.groups.push(node);
        } else {
            roots.push(node);
        }
    }

    const ungrouped: MonitorSummary[] = [];
    for (const monitor of monitors) {
        if (monitor.type === "group") {
            continue;
        }
        const parent = monitor.parent != null ? nodes.get(monitor.parent) : undefined;
        if (parent) {
            parent.monitors.push(monitor);
        } else {
            ungrouped.push(monitor);
        }
    }

    const byNodeOrder = (a: { weight: number; name: string }, b: { weight: number; name: string }): number =>
        b.weight - a.weight || a.name.localeCompare(b.name);
    const sortNode = (node: GroupNode) => {
        node.monitors.sort(byWeightThenName);
        node.groups.sort(byNodeOrder);
        node.groups.forEach(sortNode);
    };
    roots.sort(byNodeOrder);
    roots.forEach(sortNode);

    return { roots, ungrouped };
}

/**
 * Monitor and down counts for a node's whole subtree, so a parent header
 * reports what is actually inside it.
 * @param node Group node
 * @returns Totals including subgroups
 */
function nodeTotals(node: GroupNode): { count: number; down: number } {
    let count = node.monitors.length;
    let down = node.monitors.filter((m) => m.status === 0).length;
    for (const child of node.groups) {
        const totals = nodeTotals(child);
        count += totals.count;
        down += totals.down;
    }
    return { count, down };
}

/**
 * What to show next to the name: the check target for each type.
 *
 * Ping monitors are checked by hostname, and the old schema left a bare
 * "https://" in their url column — showing that was pure noise. Push
 * monitors have no target; their last message ("OK") is the honest thing.
 * @param monitor Monitor row
 * @returns Target string
 */
function monitorTarget(monitor: MonitorSummary): string {
    if (monitor.type === "ping") {
        return monitor.hostname?.trim() || "ICMP";
    }
    const url = monitor.url?.trim();
    if (url && url !== "https://" && url !== "http://") {
        return url;
    }
    return monitor.lastMessage?.trim() || "—";
}

/**
 * One monitor row. Status is never colour alone; a word always accompanies it.
 */
function MonitorRow({
    monitor,
    indent = 0,
    selected,
    onToggle,
    onEdit,
    onContextMenu,
}: {
    monitor: MonitorSummary;
    indent?: number;
    selected: Set<number>;
    onToggle: (id: number) => void;
    onEdit: (id: number) => void;
    onContextMenu?: (monitor: MonitorSummary, x: number, y: number) => void;
}) {
    const status = statusOf(monitor.status);
    const isSelected = selected.has(monitor.id);

    return (
        <tr
            key={monitor.id}
            data-selected={isSelected || undefined}
            className="border-b border-border/60 last:border-0 hover:bg-surface data-[selected]:bg-surface"
            onContextMenu={(event) => {
                if (!onContextMenu) {
                    return;
                }
                event.preventDefault();
                onContextMenu(monitor, event.clientX, event.clientY);
            }}
        >
            <td className="py-2 pl-4">
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(monitor.id)}
                    aria-label={`Select ${monitor.name}`}
                    className="size-3.5 accent-[var(--primary)]"
                />
            </td>
            <td className="py-2 pr-4 pl-1" style={{ paddingLeft: `${4 + indent * 18}px` }}>
                {/* Name and target on one line: this view is for
                    scanning many rows, so vertical space in a row
                    is the scarce resource. */}
                <div className="flex items-baseline gap-2 truncate">
                    <button
                        type="button"
                        onClick={() => onEdit(monitor.id)}
                        className="truncate font-medium hover:text-primary hover:underline"
                    >
                        {monitor.name}
                    </button>
                    <span className="truncate text-xs text-quiet">{monitorTarget(monitor)}</span>
                </div>
            </td>
            <td className="py-2 whitespace-nowrap">
                <Badge tone={status.tone}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {status.label}
                </Badge>
                {!monitor.active ? <span className="ml-2 text-[11px] text-quiet">paused</span> : null}
            </td>
            <td className="tnum py-2 pl-3 text-right whitespace-nowrap">{formatUptime(monitor.uptime24h)}</td>
            <td className="tnum py-2 pl-3 text-right whitespace-nowrap">{formatUptime(monitor.uptime7d)}</td>
            <td className="tnum py-2 pl-3 text-right whitespace-nowrap">{formatPing(monitor.ping)}</td>
            <td className="tnum py-2 pl-3 text-right whitespace-nowrap text-quiet">{ageOf(monitor.lastCheck)} ago</td>
            <td className="py-2 pr-4 pl-3 text-xs whitespace-nowrap text-quiet">{monitor.type}</td>
            <td className="py-2 pr-4 pl-3 text-right">
                {onContextMenu ? (
                    <button
                        type="button"
                        aria-label={`Actions for ${monitor.name}`}
                        title="Actions"
                        className="rounded px-1.5 py-0.5 text-quiet hover:bg-surface hover:text-primary"
                        onClick={(event) => onContextMenu(monitor, event.clientX, event.clientY)}
                    >
                        ⋯
                    </button>
                ) : null}
            </td>
        </tr>
    );
}

/**
 * Column widths, shared by the flat and grouped tables so columns align.
 */
function MonitorColgroup() {
    return (
        <colgroup>
            <col className="w-8" />
            <col className="w-[30rem]" />
            <col className="w-32" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-10" />
        </colgroup>
    );
}

/**
 * Table header, shared by the flat and grouped tables.
 */
function MonitorHead() {
    return (
        <thead>
            <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                <th className="w-8 py-2 pl-4" />
                <th className="py-2 pl-1 font-medium">Monitor</th>
                <th className="w-32 py-2 font-medium">Status</th>
                <th className="w-20 py-2 pl-3 text-right font-medium whitespace-nowrap">24h</th>
                <th className="w-20 py-2 pl-3 text-right font-medium whitespace-nowrap">7d</th>
                <th className="w-20 py-2 pl-3 text-right font-medium whitespace-nowrap">Ping</th>
                <th className="w-24 py-2 pl-3 text-right font-medium whitespace-nowrap">Checked</th>
                <th className="w-24 py-2 pr-4 pl-3 font-medium whitespace-nowrap">Type</th>
                <th className="w-10 py-2 pr-4 pl-3 font-medium" />
            </tr>
        </thead>
    );
}

/**
 * Flat table: every row, no sections. Used for search results, where
 * grouping would hide matches inside collapsed sections.
 */
function MonitorTable({
    monitors,
    selected,
    onToggle,
    onEdit,
    onContextMenu,
}: {
    monitors: MonitorSummary[];
    selected: Set<number>;
    onToggle: (id: number) => void;
    onEdit: (id: number) => void;
    onContextMenu?: (monitor: MonitorSummary, x: number, y: number) => void;
}) {
    return (
        <div className="overflow-x-auto">
            {/* table-fixed with an explicit colgroup: an auto layout table lets the
            name column absorb all the width, which squeezes the numeric columns
            until their headers collide. Fixed widths keep rows comparable down
            a column, which is the point of this view. */}
            <table className="w-full table-fixed border-collapse text-sm">
                <MonitorColgroup />
                <MonitorHead />
                <tbody>
                    {monitors.map((monitor) => (
                        <MonitorRow
                            key={monitor.id}
                            monitor={monitor}
                            selected={selected}
                            onToggle={onToggle}
                            onEdit={onEdit}
                            onContextMenu={onContextMenu}
                        />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/**
 * Grouped table: a collapsible tree of groups, subgroups and monitors.
 *
 * Collapse state persists in localStorage so the board keeps the shape the
 * operator left it in across refreshes.
 */
function GroupedTable({
    roots,
    ungrouped,
    selected,
    onToggle,
    onEdit,
    onContextMenu,
    onGroupMenu,
}: {
    roots: GroupNode[];
    ungrouped: MonitorSummary[];
    selected: Set<number>;
    onToggle: (id: number) => void;
    onEdit: (id: number) => void;
    onContextMenu?: (monitor: MonitorSummary, x: number, y: number) => void;
    onGroupMenu?: (group: MonitorSummary, x: number, y: number) => void;
}) {
    const [collapsed, setCollapsed] = useState<Set<number>>(() => {
        try {
            const raw = window.localStorage.getItem("flatline.collapsedGroups");
            return new Set(raw ? (JSON.parse(raw) as number[]) : []);
        } catch {
            return new Set();
        }
    });

    function toggle(id: number) {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            try {
                window.localStorage.setItem("flatline.collapsedGroups", JSON.stringify([...next]));
            } catch {
                // Storage can be unavailable; collapsing just will not persist.
            }
            return next;
        });
    }

    /** Header for a group node, indented by nesting depth. */
    function nodeHeader(node: GroupNode, depth: number, totals: { count: number; down: number }) {
        const isCollapsed = collapsed.has(node.id);
        return (
            <tr
                className="border-b border-border bg-surface/60"
                onContextMenu={(event) => {
                    if (!onGroupMenu) {
                        return;
                    }
                    event.preventDefault();
                    onGroupMenu(node.group, event.clientX, event.clientY);
                }}
            >
                <td colSpan={9} className="py-1.5 pr-4 pl-4" style={{ paddingLeft: `${16 + depth * 18}px` }}>
                    <button
                        type="button"
                        onClick={() => toggle(node.id)}
                        aria-expanded={!isCollapsed}
                        className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide uppercase hover:text-primary"
                    >
                        <span className="inline-block w-3 text-quiet">{isCollapsed ? "▸" : "▾"}</span>
                        {node.name}
                    </button>
                    <span className="ml-2 text-xs text-quiet">
                        <span className="tnum">{totals.count}</span>
                        {totals.down > 0 ? (
                            <span className="ml-1 font-semibold text-bad">
                                · <span className="tnum">{totals.down}</span> down
                            </span>
                        ) : (
                            <span className="ml-1">· all up</span>
                        )}
                    </span>
                    {onGroupMenu ? (
                        <button
                            type="button"
                            aria-label={`Actions for group ${node.name}`}
                            title="Group actions"
                            className="ml-2 rounded px-1.5 py-0.5 text-xs text-quiet hover:bg-card hover:text-primary"
                            onClick={(event) => onGroupMenu(node.group, event.clientX, event.clientY)}
                        >
                            ⋯
                        </button>
                    ) : null}
                </td>
            </tr>
        );
    }

    /** One node: its header and monitors, then its subgroups as siblings. */
    function renderNode(node: GroupNode, depth: number, guard: number): React.ReactNode {
        if (guard > 8) {
            return null;
        }
        const isCollapsed = collapsed.has(node.id);
        return (
            <Fragment key={node.id}>
                <tbody>
                    {nodeHeader(node, depth, nodeTotals(node))}
                    {!isCollapsed &&
                        node.monitors.map((monitor) => (
                            <MonitorRow
                                key={monitor.id}
                                monitor={monitor}
                                indent={depth + 1}
                                selected={selected}
                                onToggle={onToggle}
                                onEdit={onEdit}
                                onContextMenu={onContextMenu}
                            />
                        ))}
                </tbody>
                {!isCollapsed && node.groups.map((child) => renderNode(child, depth + 1, guard + 1))}
            </Fragment>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-sm">
                <MonitorColgroup />
                <MonitorHead />
                {roots.map((node) => renderNode(node, 0, 0))}
                {ungrouped.length > 0 ? (
                    <tbody key="ungrouped">
                        <tr className="border-b border-border bg-surface/60">
                            <td colSpan={9} className="py-1.5 pr-4 pl-4">
                                <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide text-quiet uppercase">
                                    <span className="inline-block w-3" />
                                    Ungrouped
                                </span>
                                <span className="ml-2 text-xs text-quiet">
                                    <span className="tnum">{ungrouped.length}</span>
                                    {ungrouped.some((m) => m.status === 0) ? (
                                        <span className="ml-1 font-semibold text-bad">
                                            ·{" "}
                                            <span className="tnum">
                                                {ungrouped.filter((m) => m.status === 0).length}
                                            </span>{" "}
                                            down
                                        </span>
                                    ) : (
                                        <span className="ml-1">· all up</span>
                                    )}
                                </span>
                            </td>
                        </tr>
                        {ungrouped.map((monitor) => (
                            <MonitorRow
                                key={monitor.id}
                                monitor={monitor}
                                selected={selected}
                                onToggle={onToggle}
                                onEdit={onEdit}
                                onContextMenu={onContextMenu}
                            />
                        ))}
                    </tbody>
                ) : null}
            </table>
        </div>
    );
}

/**
 * The operator's monitor table.
 */
function Dashboard() {
    const [authed, setAuthed] = useState(() => Boolean(getToken()));
    const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
    const [rosterLoaded, setRosterLoaded] = useState(false);
    const health = useMemo(() => (rosterLoaded ? healthFromMonitors(monitors) : null), [monitors, rosterLoaded]);
    const tree = useMemo(() => groupTree(monitors), [monitors]);
    const loadEpoch = useRef(0);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [query, setQuery] = useState("");
    const [menu, setMenu] = useState<MenuAnchor | null>(null);
    const [renaming, setRenaming] = useState<MonitorSummary | null>(null);
    const [moving, setMoving] = useState<MonitorSummary | null>(null);
    const [deletingGroup, setDeletingGroup] = useState<{
        group: MonitorSummary;
        rows: number;
        children: number;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [formState, setFormState] = useState<
        | { mode: "create"; initial?: Partial<MonitorSummary> & Record<string, unknown> }
        | { mode: "edit"; monitor: MonitorSummary & Record<string, unknown> }
        | null
    >(null);
    const [detailId, setDetailId] = useState<number | null>(null);
    const [agentsOpen, setAgentsOpen] = useState(false);

    const load = useCallback(async (strict = false, signal?: AbortSignal) => {
        const epoch = ++loadEpoch.current;
        try {
            const next = await fetchAllMonitors(signal);
            if (epoch !== loadEpoch.current) {
                return;
            }
            setMonitors(next);
            setRosterLoaded(true);
            setError(null);
        } catch (e) {
            if (epoch !== loadEpoch.current) {
                return;
            }
            if (e instanceof ApiError && e.status === 401) {
                setToken(null);
                setAuthed(false);
                return;
            }
            setError(e instanceof Error ? e.message : "Failed to load.");
            if (strict) {
                throw e;
            }
        }
    }, []);

    // Initial/reconnect snapshot, then only committed heartbeat deltas.
    useEffect(() => {
        if (!authed) {
            return;
        }

        const stop = watchLive({
            metrics: false,
            snapshot: (signal) => load(true, signal),
            event: (event) => {
                if (event.type !== "heartbeat") {
                    return;
                }
                setMonitors((previous) =>
                    previous.map((monitor) =>
                        monitor.id === event.monitorId ? { ...monitor, ...event.patch } : monitor
                    )
                );
                setError(null);
            },
            error: (error) => {
                if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                    setToken(null);
                    setAuthed(false);
                    return;
                }
                setError("Live updates disconnected; reconnecting.");
            },
        });
        return () => {
            loadEpoch.current++;
            stop();
        };
    }, [authed, load]);

    // "/" focuses search, escape clears it and any selection.
    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            const target = event.target as HTMLElement | null;
            const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

            if (event.key === "/" && !typing) {
                event.preventDefault();
                document.getElementById("monitor-search")?.focus();
            }

            if (event.key === "Escape") {
                setQuery("");
                setSelected(new Set());
                (document.activeElement as HTMLElement | null)?.blur();
            }
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const filtered = useMemo(() => {
        if (!query.trim()) {
            return monitors;
        }
        const needle = query.trim().toLowerCase();
        return monitors.filter(
            (m) =>
                m.name.toLowerCase().includes(needle) ||
                (m.url ?? "").toLowerCase().includes(needle) ||
                m.type.toLowerCase().includes(needle)
        );
    }, [monitors, query]);

    async function applyToSelection(action: "pause" | "resume" | "delete") {
        if (action === "delete") {
            const count = selected.size;
            if (!window.confirm(`Delete ${count} monitor${count === 1 ? "" : "s"}? This cannot be undone.`)) {
                return;
            }
        }
        setBusy(true);
        try {
            await Promise.all(
                [...selected].map((id) => {
                    if (action === "pause") {
                        return pauseMonitor(id);
                    }
                    if (action === "resume") {
                        return resumeMonitor(id);
                    }
                    return deleteMonitor(id);
                })
            );
            setSelected(new Set());
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Action failed.");
        } finally {
            setBusy(false);
        }
    }

    // Group options for the form's Group picker. A group being edited cannot
    // move inside itself, so its own subtree is excluded from the choices.
    const groupChoices = useMemo(
        () =>
            groupOptions(
                monitors,
                formState?.mode === "edit" && formState.monitor.type === "group" ? formState.monitor.id : null
            ),
        [monitors, formState]
    );

    // Link targets for the form's "Linked websites" picker: groups and
    // monitors, never the server being edited itself.
    const linkCandidates = useMemo(
        () => buildLinkCandidates(monitors, formState?.mode === "edit" ? formState.monitor.id : null),
        [monitors, formState]
    );

    // Right-click/⋯ menu contents: groups manage the tree, monitors move
    // through it. Built per anchor so it always sees the current roster.
    const menuItems: MenuItem[] = useMemo(() => {
        if (!menu) {
            return [];
        }
        const monitor = menu.monitor;
        if (monitor.type === "group") {
            return [
                {
                    label: "New subgroup…",
                    onSelect: () => {
                        setFormState({ mode: "create", initial: { type: "group", parent: monitor.id } });
                        setMenu(null);
                    },
                },
                {
                    label: "Rename group…",
                    onSelect: () => {
                        setRenaming(monitor);
                        setMenu(null);
                    },
                },
                {
                    label: "Move group…",
                    onSelect: () => {
                        setMoving(monitor);
                        setMenu(null);
                    },
                },
                {
                    label: "Delete group…",
                    danger: true,
                    onSelect: () => {
                        setDeletingGroup({
                            group: monitor,
                            rows: subtreeMonitorCount(monitors, monitor.id),
                            children: directChildren(monitors, monitor.id).length,
                        });
                        setMenu(null);
                    },
                },
            ];
        }
        return [
            {
                label: "Rename…",
                onSelect: () => {
                    setRenaming(monitor);
                    setMenu(null);
                },
            },
            {
                label: "Move to group…",
                onSelect: () => {
                    setMoving(monitor);
                    setMenu(null);
                },
            },
        ];
    }, [menu, monitors]);

    /**
     * Delete a group. "keep" re-parents its direct children to the group's
     * parent first, so the tree never orphans a monitor; "purge" deletes the
     * whole subtree in one request.
     */
    async function deleteGroup(mode: "keep" | "purge") {
        const target = deletingGroup;
        if (!target) {
            return;
        }
        setBusy(true);
        try {
            if (mode === "purge") {
                await deleteMonitor(target.group.id, true);
            } else {
                const children = directChildren(monitors, target.group.id);
                await Promise.all(
                    children.map((child) => updateMonitor(child.id, { parent: target.group.parent ?? null }))
                );
                await deleteMonitor(target.group.id);
            }
            setDeletingGroup(null);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Delete failed.");
            setDeletingGroup(null);
        } finally {
            setBusy(false);
        }
    }

    if (!authed) {
        return <TokenGate onSaved={() => setAuthed(true)} />;
    }

    return (
        <div className="min-h-screen">
            <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                <span className="text-sm font-semibold tracking-tight">Flatline</span>

                <Input
                    id="monitor-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search  ( / )"
                    className="ml-2 h-7 max-w-xs"
                />

                {query ? (
                    <span className="text-xs text-quiet">
                        <span className="tnum">{filtered.length}</span> of{" "}
                        <span className="tnum">{monitors.length}</span>
                    </span>
                ) : null}

                <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => navigate("/superboard")}>
                        Superboard
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            setDetailId(null);
                            setAgentsOpen((v) => !v);
                        }}
                    >
                        Agents
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setFormState({ mode: "create", initial: { type: "group" } })}
                    >
                        New group
                    </Button>
                    <Button size="sm" onClick={() => setFormState({ mode: "create" })}>
                        New monitor
                    </Button>
                    {selected.size > 0 ? (
                        <>
                            <span className="text-xs text-quiet">
                                <span className="tnum">{selected.size}</span> selected
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyToSelection("pause")}
                            >
                                Pause
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyToSelection("resume")}
                            >
                                Resume
                            </Button>
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={busy}
                                onClick={() => void applyToSelection("delete")}
                            >
                                Delete
                            </Button>
                        </>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="sm"
                        title="Forget token"
                        onClick={() => {
                            setToken(null);
                            setAuthed(false);
                        }}
                    >
                        Disconnect
                    </Button>
                </div>
            </header>

            {health ? <HealthStrip health={health} /> : null}

            {error ? (
                <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error}
                </div>
            ) : null}

            {agentsOpen ? (
                <AgentPanel
                    onClose={() => {
                        setAgentsOpen(false);
                        void load();
                    }}
                />
            ) : detailId !== null ? (
                <MonitorDetail
                    id={detailId}
                    onBack={() => {
                        setDetailId(null);
                        void load();
                    }}
                    onEdit={(monitor) => setFormState({ mode: "edit", monitor })}
                />
            ) : filtered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-quiet">
                    {monitors.length === 0 ? "No monitors yet." : "Nothing matches that search."}
                </p>
            ) : query.trim() ? (
                <MonitorTable
                    monitors={filtered}
                    selected={selected}
                    onToggle={(id) =>
                        setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) {
                                next.delete(id);
                            } else {
                                next.add(id);
                            }
                            return next;
                        })
                    }
                    onEdit={(id) => {
                        setAgentsOpen(false);
                        setDetailId(id);
                    }}
                    onContextMenu={(monitor, x, y) => setMenu({ x, y, monitor })}
                />
            ) : (
                <GroupedTable
                    roots={tree.roots}
                    ungrouped={tree.ungrouped}
                    selected={selected}
                    onToggle={(id) =>
                        setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) {
                                next.delete(id);
                            } else {
                                next.add(id);
                            }
                            return next;
                        })
                    }
                    onEdit={(id) => {
                        setAgentsOpen(false);
                        setDetailId(id);
                    }}
                    onContextMenu={(monitor, x, y) => setMenu({ x, y, monitor })}
                    onGroupMenu={(group, x, y) => setMenu({ x, y, monitor: group })}
                />
            )}

            {menu ? <ServerMenu anchor={menu} items={menuItems} onClose={() => setMenu(null)} /> : null}
            {renaming ? (
                <RenameDialog monitor={renaming} currentName={renaming.name} onClose={() => setRenaming(null)} />
            ) : null}
            {moving ? (
                <MoveDialog
                    monitor={moving}
                    options={groupOptions(monitors, moving.type === "group" ? moving.id : null)}
                    currentParent={moving.parent ?? null}
                    onClose={() => setMoving(null)}
                />
            ) : null}
            {deletingGroup ? (
                <DeleteGroupDialog
                    group={deletingGroup.group}
                    rows={deletingGroup.rows}
                    children={deletingGroup.children}
                    parentName={groupPath(monitors, deletingGroup.group.parent)}
                    onDelete={(mode) => deleteGroup(mode)}
                    onClose={() => setDeletingGroup(null)}
                />
            ) : null}

            {formState ? (
                <div
                    className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
                    onClick={() => setFormState(null)}
                >
                    <div
                        className="mt-8 w-full max-w-2xl rounded-lg border border-border bg-card p-5"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 className="mb-4 text-base font-semibold">
                            {formState.mode === "create"
                                ? formState.initial?.type === "group"
                                    ? "New group"
                                    : "New monitor"
                                : `Edit ${formState.monitor.name}`}
                        </h2>
                        <MonitorForm
                            initial={formState.mode === "edit" ? formState.monitor : (formState.initial ?? null)}
                            groupChoices={groupChoices}
                            linkCandidates={linkCandidates}
                            onSaved={() => {
                                setFormState(null);
                                void load();
                            }}
                            onCancel={() => setFormState(null)}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Site root: a client's status domain shows its status page; everything
 * else is the operator dashboard.
 *
 * A stored operator token means "this browser is the operator", so the
 * dashboard wins immediately — client status domains have their own origin
 * and therefore their own (empty) token store. Without a token the host is
 * resolved against the status-page domain map first, so a mapped client
 * domain renders its page instead of a login gate.
 */
function RootRoute() {
    const [authed] = useState(() => Boolean(getToken()));
    if (authed) {
        return <Dashboard />;
    }
    return <StatusPageApp slug={null} fallback={<Dashboard />} />;
}

/**
 * Application root.
 *
 * Routes: the operator dashboard at "/" (unless the host maps to a status
 * page), public status pages at "/status/:slug", the wall board at
 * "/superboard" (optionally group-scoped), and the chrome-free board at
 * "/superboard/kiosk". The route is resolved before either view mounts, so the
 * dashboard's polling never runs while the board or a status page is open.
 */
export default function App() {
    const path = usePath();
    const board = boardRouteFrom(path);

    if (board) {
        return <SuperboardApp kiosk={board.kiosk} filter={board.filter} />;
    }

    const statusSlug = statusSlugFromPath(path);
    if (statusSlug) {
        return <StatusPageApp slug={statusSlug} />;
    }

    if (path === "/") {
        return <RootRoute />;
    }

    return <Dashboard />;
}
