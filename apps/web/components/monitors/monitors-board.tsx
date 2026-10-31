"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Search } from "lucide-react";

import { useBoardData } from "@/components/board/board-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIdleCalm } from "@/hooks/use-idle-calm";
import { attentionMonitorIds, deriveAttention } from "@/lib/attention";
import {
    EMPTY_FILTER,
    boardTotals,
    buildBoard,
    filterFacets,
    isFilterActive,
    type FilterState,
    type SortKey,
    type StatusKey,
} from "@/lib/board-model";
import {
    DENSITY_KEY,
    loadDensity,
    loadViews,
    serializeBoardQuery,
    storeViews,
    type BoardQuery,
    type Density,
    type SavedView,
    type SavedViews,
} from "@/lib/board-url";
import type { MonitorSummary } from "@/lib/monitor-types";
import { shouldHoldReorder } from "@/lib/motion";
import { orderBasis } from "@/lib/order-basis";

import { BoardActionsContext, BoardViewContext, type BoardActions, type BoardView } from "./board-context";
import { BoardSkeleton, EmptyBoard, LoadFailed, NoMatches } from "./board-states";
import { BoardTree } from "./board-tree";
import { DisplayMenu } from "./display-menu";
import { FilterMenu } from "./filter-menu";
import { NewMonitorDialog, newMonitorPresets, setNewMonitorParams } from "./new-monitor-dialog";
import { PeekPanel } from "./peek-panel";
import { StatusSummary } from "./status-summary";
import { ViewsMenu } from "./views-menu";

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
    const searchParams = useSearchParams();
    const data = useBoardData();
    // `?new=1` (the header button, the command palette, "New subgroup")
    // opens the create dialog; closing it takes the keys out again.
    const createPresets = useMemo(
        () => newMonitorPresets(new URLSearchParams(searchParams.toString())),
        [searchParams]
    );
    const { monitors, rosterLoaded } = data;

    const [filter, setFilter] = useState<FilterState>(initialQuery.filter);
    const [sort, setSort] = useState<SortKey>(initialQuery.sort);
    // `openId` is what the URL says is open; `peekId` what the panel shows.
    // They differ only after the open monitor was deleted: the panel keeps
    // saying so while the URL forgets it.
    const [openId, setOpenId] = useState<number | null>(initialQuery.open);
    const [peekId, setPeekId] = useState<number | null>(initialQuery.open);
    const [density, setDensityState] = useState<Density>("comfortable");
    const [views, setViews] = useState<SavedViews>({ views: [], defaultId: null });
    const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
    const [selected] = useState<Set<number>>(new Set());
    const [cursorId, setCursorId] = useState<number | null>(null);
    const [pointerOverList, setPointerOverList] = useState(false);
    const calm = useIdleCalm();

    // localStorage is the browser's: read it after the server render. A URL
    // without board state gets the default saved view, as before.
    useEffect(() => {
        setCollapsed(readCollapsed());
        setDensityState(loadDensity(window.localStorage));
        const saved = loadViews(window.localStorage);
        setViews(saved);
        const preferred = saved.views.find((v) => v.id === saved.defaultId);
        if (!initialQuery.hasParams && preferred) {
            setFilter(preferred.filter);
            setSort(preferred.sort);
        }
        // Only on mount: later URL changes come from this board itself.
    }, []);

    const changeViews = useCallback((next: SavedViews) => {
        setViews(next);
        storeViews(window.localStorage, next);
    }, []);
    const applyView = useCallback((view: SavedView) => {
        setFilter(view.filter);
        setSort(view.sort);
    }, []);
    const setDensity = useCallback((next: Density) => {
        setDensityState(next);
        try {
            window.localStorage.setItem(DENSITY_KEY, next);
        } catch {
            // Storage can be unavailable; the choice just will not persist.
        }
    }, []);

    // The board lives in the URL so it can be linked. History is replaced in
    // place (Next keeps useSearchParams in step) rather than navigated, so a
    // keystroke in the search box never costs a server render.
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const search = serializeBoardQuery({ filter, sort, open: openId }, window.location.search);
            if (search !== window.location.search) {
                window.history.replaceState(null, "", `${window.location.pathname}${search}`);
            }
        }, 250);
        return () => window.clearTimeout(timer);
    }, [filter, sort, openId]);

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
    const facets = useMemo(() => filterFacets(monitors), [monitors]);
    const forceOpen = isFilterActive(filter);

    const openMonitor = useCallback((id: number) => {
        setOpenId(id);
        setPeekId(id);
        setCursorId(id);
    }, []);
    const closePeek = useCallback(() => {
        setOpenId(null);
        setPeekId(null);
    }, []);
    const peekGone = useCallback(() => setOpenId(null), []);
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
        openId: peekId,
        cursorId,
        cueRows: data.cue.rows,
        cueSeq: data.cue.seq,
        now: data.now,
    };
    const hasRows = board.roots.length > 0 || board.ungrouped.length > 0;

    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
                    {rosterLoaded ? (
                        <StatusSummary
                            totals={totals}
                            attention={attention}
                            active={filter.status}
                            onToggleStatus={toggleStatus}
                            changed={data.cue.group && !calm ? data.cue.changed : 0}
                        />
                    ) : null}
                    <div className="ml-auto flex items-center gap-2">
                        <div className="relative">
                            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                            <Input
                                id="board-search"
                                type="search"
                                value={filter.q}
                                onChange={(event) => setFilter((prev) => ({ ...prev, q: event.target.value }))}
                                placeholder="Search  /"
                                aria-label="Search monitors"
                                className="h-8 w-56 pl-8"
                            />
                        </div>
                        <FilterMenu
                            filter={filter}
                            onChange={setFilter}
                            types={facets.types}
                            tags={facets.tags}
                            attentionCount={attentionIds.size}
                        />
                        <DisplayMenu sort={sort} onSort={setSort} density={density} onDensity={setDensity} />
                        <ViewsMenu
                            state={views}
                            onChange={changeViews}
                            onApply={applyView}
                            filter={filter}
                            sort={sort}
                        />
                    </div>
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
                                <EmptyBoard onNewMonitor={() => setNewMonitorParams({})} />
                            ) : !hasRows ? (
                                <NoMatches onClear={clearFilters} />
                            ) : (
                                <BoardTree board={board} />
                            )}
                        </section>
                    </BoardViewContext.Provider>
                </BoardActionsContext.Provider>
            </div>
            <PeekPanel id={peekId} onClose={closePeek} onGone={peekGone} />
            <NewMonitorDialog
                presets={createPresets}
                onClose={() => setNewMonitorParams(null)}
                onSaved={(id) => {
                    setNewMonitorParams(null);
                    void data.reload();
                    openMonitor(id);
                }}
            />
        </div>
    );
}
