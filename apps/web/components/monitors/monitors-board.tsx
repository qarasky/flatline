"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { Button } from "@/components/ui/button";
import { useIdleCalm } from "@/hooks/use-idle-calm";
import { attentionMonitorIds, deriveAttention } from "@/lib/attention";
import {
    EMPTY_FILTER,
    boardTotals,
    buildBoard,
    isFilterActive,
    type FilterState,
    type SortKey,
    type StatusKey,
} from "@/lib/board-model";
import type { BoardQuery, Density } from "@/lib/board-url";
import type { MonitorSummary } from "@/lib/monitor-types";
import { shouldHoldReorder } from "@/lib/motion";
import { orderBasis } from "@/lib/order-basis";

import { BoardActionsContext, BoardViewContext, type BoardActions, type BoardView } from "./board-context";
import { BoardSkeleton, EmptyBoard, LoadFailed, NoMatches } from "./board-states";
import { BoardTree } from "./board-tree";
import { StatusSummary } from "./status-summary";

/** Where the old board kept collapsed groups; reused so a browser keeps its choice. */
const COLLAPSED_KEY = "flatline.collapsedGroups";

function readCollapsed(): Set<number> {
    try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        return new Set(raw ? (JSON.parse(raw) as number[]) : []);
    } catch {
        return new Set();
    }
}

/**
 * The Monitors page's client root: the group tree with live updates, the
 * status summary and the board's own state (filters, sort, open monitor,
 * collapsed groups). Data comes from the admin layout's BoardDataProvider.
 */
export function MonitorsBoard({ initialQuery }: { initialQuery: BoardQuery & { hasParams: boolean } }) {
    const router = useRouter();
    const data = useBoardData();
    const { monitors, rosterLoaded } = data;

    const [filter, setFilter] = useState<FilterState>(initialQuery.filter);
    const [sort] = useState<SortKey>(initialQuery.sort);
    const [openId, setOpenId] = useState<number | null>(initialQuery.open);
    const [density] = useState<Density>("comfortable");
    const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
    const [selected] = useState<Set<number>>(new Set());
    const [cursorId, setCursorId] = useState<number | null>(null);
    const [pointerOverList, setPointerOverList] = useState(false);
    const calm = useIdleCalm();

    // localStorage is the browser's: read it after the server render.
    useEffect(() => setCollapsed(readCollapsed()), []);

    const attention = useMemo(
        () =>
            deriveAttention({
                monitors,
                strips: data.strips,
                nowMs: data.now,
                changedAt: data.changedAt,
                agentWarnings: data.agentWarnings,
                backups: data.backups,
            }),
        [monitors, data.strips, data.now, data.changedAt, data.agentWarnings, data.backups]
    );
    const attentionIds = useMemo(() => attentionMonitorIds(attention), [attention]);

    // While the pointer is over the list or rows are selected, a status
    // change does not move rows: sort keys stay as they were (orderBasis).
    const hold = shouldHoldReorder({ pointerOverList, selectionSize: selected.size, menuOpen: false });
    const basisRef = useRef<Map<number, MonitorSummary>>(new Map());
    basisRef.current = orderBasis(basisRef.current, monitors, hold && basisRef.current.size > 0);
    const basis = hold ? basisRef.current : undefined;

    const board = useMemo(
        () => buildBoard(monitors, { sort, filter, attentionIds, basis, strips: data.strips }),
        [monitors, sort, filter, attentionIds, basis, data.strips]
    );
    const totals = useMemo(() => boardTotals(monitors), [monitors]);
    const forceOpen = isFilterActive(filter);

    const openMonitor = useCallback((id: number) => {
        setOpenId(id);
        setCursorId(id);
    }, []);
    const toggleGroup = useCallback((id: number) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            try {
                window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
            } catch {
                // Storage can be unavailable; collapsing just will not persist.
            }
            return next;
        });
    }, []);
    const toggleSelect = useCallback(() => undefined, []);

    // Handlers behind a stable object so memoised rows do not re-render when the closures change.
    const latest = useRef<BoardActions>({ openMonitor, toggleSelect, toggleGroup });
    latest.current = { openMonitor, toggleSelect, toggleGroup };
    const actions = useMemo<BoardActions>(
        () => ({
            openMonitor: (id) => latest.current.openMonitor(id),
            toggleSelect: (id) => latest.current.toggleSelect(id),
            toggleGroup: (id) => latest.current.toggleGroup(id),
        }),
        []
    );

    const toggleStatus = useCallback((status: StatusKey) => {
        setFilter((prev) => ({
            ...prev,
            status: prev.status.includes(status) ? prev.status.filter((s) => s !== status) : [...prev.status, status],
        }));
    }, []);
    const clearFilters = useCallback(() => setFilter(EMPTY_FILTER), []);

    const view: BoardView = {
        density,
        calm,
        strips: data.strips,
        selected,
        collapsed,
        forceOpen,
        openId,
        cursorId,
        cueRows: data.cue.rows,
        cueSeq: data.cue.seq,
        now: data.now,
    };
    const hasRows = board.roots.length > 0 || board.ungrouped.length > 0;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-11 flex-wrap items-center gap-3 border-b px-4 py-2">
                {rosterLoaded ? (
                    <StatusSummary
                        totals={totals}
                        attention={attention}
                        active={filter.status}
                        onToggleStatus={toggleStatus}
                        changed={data.cue.group && !calm ? data.cue.changed : 0}
                    />
                ) : null}
            </div>
            {data.paused ? (
                <div
                    role="status"
                    className="bg-status-warn/10 text-status-warn flex items-center gap-3 px-4 py-1.5 text-xs"
                >
                    <span>
                        Live updates paused
                        {data.pending > 0 ? <span className="tabular-nums"> · {data.pending} waiting</span> : null}
                    </span>
                    <Button variant="outline" size="xs" onClick={() => data.setPaused(false)}>
                        Resume
                    </Button>
                </div>
            ) : null}
            {data.error && rosterLoaded ? (
                <p role="status" className="text-status-warn px-4 py-1.5 text-xs">
                    {data.error}
                </p>
            ) : null}
            <BoardActionsContext.Provider value={actions}>
                <BoardViewContext.Provider value={view}>
                    <section
                        aria-label="Monitors"
                        className="board-list"
                        data-density={density}
                        data-strips={data.strips.size > 0 ? "on" : "off"}
                        data-selecting={selected.size > 0 || undefined}
                        onPointerEnter={() => setPointerOverList(true)}
                        onPointerLeave={() => setPointerOverList(false)}
                    >
                        {!rosterLoaded ? (
                            data.error ? (
                                <LoadFailed message={data.error} onRetry={() => void data.reload()} />
                            ) : (
                                <BoardSkeleton />
                            )
                        ) : monitors.length === 0 ? (
                            <EmptyBoard onNewMonitor={() => router.push("/monitors?new=1")} />
                        ) : !hasRows ? (
                            <NoMatches onClear={clearFilters} />
                        ) : (
                            <BoardTree board={board} />
                        )}
                    </section>
                </BoardViewContext.Provider>
            </BoardActionsContext.Provider>
        </div>
    );
}
