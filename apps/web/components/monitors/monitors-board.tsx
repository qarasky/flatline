"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Search } from "lucide-react";

import { useBoardData } from "@/components/board/board-data";
import { useAttention } from "@/components/board/use-attention";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIdleCalm } from "@/hooks/use-idle-calm";
import { attentionMonitorIds } from "@/lib/attention";
import {
    EMPTY_FILTER,
    boardTotals,
    buildBoard,
    filterFacets,
    isFilterActive,
    visibleRowIds,
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
import { boardKey, escapeStep, moveCursor, type KeyTarget } from "@/lib/board-keys";
import { muteMonitor, pauseMonitor, resumeMonitor, unmuteMonitor } from "@/lib/monitors-api";
import { orderBasis } from "@/lib/order-basis";
import type { RowMenuId } from "@/lib/row-menu";

import { BoardActionsContext, BoardViewContext, type BoardActions, type BoardView } from "./board-context";
import { BoardSkeleton, EmptyBoard, LoadFailed, NoMatches } from "./board-states";
import { BoardTree } from "./board-tree";
import { DisplayMenu } from "./display-menu";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { DeleteMonitorsDialog } from "./delete-monitors-dialog";
import { FilterMenu } from "./filter-menu";
import { MoveDialog } from "./move-dialog";
import { NewMonitorDialog, newMonitorPresets, setNewMonitorParams } from "./new-monitor-dialog";
import { PeekPanel } from "./peek-panel";
import { RenameDialog } from "./rename-dialog";
import { SelectionBar } from "./selection-bar";
import { StatusSummary } from "./status-summary";
import { ViewsMenu } from "./views-menu";

/** Where the old board kept collapsed groups; reused so a browser keeps its choice. */
const COLLAPSED_KEY = "flatline.collapsedGroups";

/** What kind of element a key was pressed in. Radix checkboxes are buttons with role=checkbox. */
function keyTarget(el: EventTarget | null): KeyTarget {
    if (!(el instanceof HTMLElement)) {
        return "other";
    }
    if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return "text";
    }
    if (el instanceof HTMLInputElement) {
        return el.type === "checkbox" || el.type === "radio" ? "checkbox" : "text";
    }
    if (el.getAttribute("role") === "checkbox") {
        return "checkbox";
    }
    return el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement ? "control" : "other";
}

/** A dialog that is open over the board, which the board's dialogs and menus are. */
type BoardDialog =
    | { kind: "rename" | "move" | "deleteGroup"; monitor: MonitorSummary }
    | { kind: "deleteMonitors"; monitors: MonitorSummary[] };

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
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [menusOpen, setMenusOpen] = useState(0);
    const [dialog, setDialog] = useState<BoardDialog | null>(null);
    const [busy, setBusy] = useState(false);
    // "Edit…" from a row menu opens the peek with the form showing; the
    // nonce remounts the detail so a second Edit on the same row works.
    const [peekEdit, setPeekEdit] = useState({ editing: false, nonce: 0 });
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

    const attention = useAttention();
    const attentionIds = useMemo(() => attentionMonitorIds(attention), [attention]);

    // While the pointer is over the list or rows are selected, a status
    // change does not move rows: sort keys stay as they were (orderBasis).
    const hold = shouldHoldReorder({ pointerOverList, selectionSize: selected.size, menuOpen: menusOpen > 0 });
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
    const rowOrder = useMemo(() => visibleRowIds(board, collapsed, forceOpen), [board, collapsed, forceOpen]);

    const openMonitor = useCallback((id: number, edit = false) => {
        setOpenId(id);
        setPeekId(id);
        setCursorId(id);
        setPeekEdit((prev) => ({ editing: edit, nonce: edit ? prev.nonce + 1 : prev.nonce }));
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
    const toggleSelect = useCallback((id: number) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    /** Run an API call, then refresh the roster; a failure shows above the list. */
    const act = useCallback(
        async (task: () => Promise<unknown>) => {
            try {
                await task();
                await data.reload();
            } catch (e) {
                data.setError(e instanceof Error ? e.message : "That did not work.");
            }
        },
        [data]
    );

    const menuAction = useCallback(
        (id: number, item: RowMenuId) => {
            const monitor = monitors.find((m) => m.id === id);
            if (!monitor) {
                return;
            }
            switch (item) {
                case "open":
                    openMonitor(id);
                    break;
                case "edit":
                    openMonitor(id, true);
                    break;
                case "rename":
                case "move":
                    setDialog({ kind: item, monitor });
                    break;
                case "delete":
                    setDialog(
                        monitor.type === "group"
                            ? { kind: "deleteGroup", monitor }
                            : { kind: "deleteMonitors", monitors: [monitor] }
                    );
                    break;
                case "newSubgroup":
                    setNewMonitorParams({ parent: id, type: "group" });
                    break;
                case "mute":
                    void act(() => muteMonitor(id));
                    break;
                case "unmute":
                    void act(() => unmuteMonitor(id));
                    break;
                case "pause":
                    void act(() => pauseMonitor(id));
                    break;
                case "resume":
                    void act(() => resumeMonitor(id));
                    break;
            }
        },
        [monitors, openMonitor, act]
    );
    const menuOpenChange = useCallback((open: boolean) => setMenusOpen((n) => Math.max(0, n + (open ? 1 : -1))), []);

    // Handlers behind a stable object so memoised rows do not re-render when the closures change.
    const latest = useRef({ openMonitor, toggleSelect, toggleGroup, menuAction, menuOpenChange });
    latest.current = { openMonitor, toggleSelect, toggleGroup, menuAction, menuOpenChange };
    const actions = useMemo<BoardActions>(
        () => ({
            openMonitor: (id) => latest.current.openMonitor(id),
            toggleSelect: (id) => latest.current.toggleSelect(id),
            toggleGroup: (id) => latest.current.toggleGroup(id),
            menuAction: (id, item) => latest.current.menuAction(id, item),
            menuOpenChange: (open) => latest.current.menuOpenChange(open),
        }),
        []
    );

    /** Pause or resume every selected monitor, reporting any that failed by name. */
    async function bulk(action: "pause" | "resume") {
        setBusy(true);
        const ids = [...selected];
        const results = await Promise.allSettled(
            ids.map((id) => (action === "pause" ? pauseMonitor(id) : resumeMonitor(id)))
        );
        const failed = ids.filter((_, i) => results[i].status === "rejected");
        const names = failed.map((id) => monitors.find((m) => m.id === id)?.name ?? `#${id}`);
        setSelected(new Set(failed));
        await data.reload();
        if (names.length > 0) {
            data.setError(`Could not ${action} ${names.join(", ")}.`);
        }
        setBusy(false);
    }

    const closeDialog = useCallback(() => setDialog(null), []);
    const dialogDone = useCallback(() => {
        setDialog(null);
        void data.reload();
    }, [data]);

    // The keyboard (lib/board-keys.ts has the table). One listener; the
    // state it needs is read through a ref so it is never stale.
    const keyState = useRef({ rowOrder, cursorId, peekId, selected, filter });
    keyState.current = { rowOrder, cursorId, peekId, selected, filter };
    useEffect(() => {
        function focusRow(id: number) {
            setCursorId(id);
            const el = document.querySelector<HTMLElement>(`[data-row-main="${id}"]`);
            el?.focus({ preventScroll: true });
            el?.scrollIntoView({ block: "nearest" });
        }
        function onKey(event: KeyboardEvent) {
            const state = keyState.current;
            const action = boardKey({
                key: event.key,
                target: keyTarget(event.target),
                overlayOpen: document.querySelector('[role="dialog"],[role="menu"]') !== null,
                modifier: event.metaKey || event.ctrlKey || event.altKey,
            });
            if (action === null) {
                return;
            }
            const ids = state.rowOrder.map((row) => row.id);
            const current = state.rowOrder.find((row) => row.id === state.cursorId);
            switch (action) {
                case "leaveField": {
                    const field = event.target as HTMLElement;
                    if (field.id === "board-search" && state.filter.q) {
                        setFilter((prev) => ({ ...prev, q: "" }));
                    }
                    field.blur();
                    return;
                }
                case "focusSearch":
                    event.preventDefault();
                    document.getElementById("board-search")?.focus();
                    return;
                case "down":
                case "up": {
                    const next = moveCursor(ids, state.cursorId, action === "down" ? 1 : -1);
                    if (next !== null) {
                        event.preventDefault();
                        focusRow(next);
                    }
                    return;
                }
                case "select":
                    if (current?.kind === "monitor") {
                        event.preventDefault();
                        toggleSelect(current.id);
                    }
                    return;
                case "open":
                    if (current) {
                        event.preventDefault();
                        if (current.kind === "group") {
                            toggleGroup(current.id);
                        } else {
                            openMonitor(current.id);
                        }
                    }
                    return;
                case "escape": {
                    const step = escapeStep({
                        peekOpen: state.peekId !== null,
                        selected: state.selected.size,
                        filterActive: isFilterActive(state.filter),
                    });
                    if (step === "closePeek") {
                        closePeek();
                    } else if (step === "clearSelection") {
                        setSelected(new Set());
                    } else if (step === "clearFilters") {
                        setFilter(EMPTY_FILTER);
                    }
                    return;
                }
            }
        }
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [closePeek, openMonitor, toggleGroup, toggleSelect]);

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
            <PeekPanel
                key={peekEdit.nonce}
                id={peekId}
                startEditing={peekEdit.editing}
                onClose={closePeek}
                onGone={peekGone}
            />
            <SelectionBar
                count={selected.size}
                busy={busy}
                onPause={() => void bulk("pause")}
                onResume={() => void bulk("resume")}
                onDelete={() =>
                    setDialog({ kind: "deleteMonitors", monitors: monitors.filter((m) => selected.has(m.id)) })
                }
                onClear={() => setSelected(new Set())}
            />
            {dialog?.kind === "rename" ? (
                <RenameDialog monitor={dialog.monitor} onClose={closeDialog} onDone={dialogDone} />
            ) : null}
            {dialog?.kind === "move" ? (
                <MoveDialog monitor={dialog.monitor} monitors={monitors} onClose={closeDialog} onDone={dialogDone} />
            ) : null}
            {dialog?.kind === "deleteGroup" ? (
                <DeleteGroupDialog
                    group={dialog.monitor}
                    monitors={monitors}
                    onClose={closeDialog}
                    onDone={dialogDone}
                />
            ) : null}
            {dialog?.kind === "deleteMonitors" ? (
                <DeleteMonitorsDialog
                    monitors={dialog.monitors}
                    onClose={closeDialog}
                    onDone={(deleted) => {
                        setSelected((prev) => new Set([...prev].filter((id) => !deleted.includes(id))));
                        if (peekId !== null && deleted.includes(peekId)) {
                            closePeek();
                        }
                        dialogDone();
                    }}
                />
            ) : null}
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
