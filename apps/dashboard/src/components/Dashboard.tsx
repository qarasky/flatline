import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    deleteMonitor,
    getToken,
    pauseMonitor,
    resumeMonitor,
    setToken,
    updateMonitor,
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
import { navigate } from "@/lib/router";
import { attentionMonitorIds, deriveAttention } from "@/lib/attention";
import {
    EMPTY_FILTER,
    SORT_KEYS,
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
    parseBoardQuery,
    serializeBoardQuery,
    storeViews,
    type Density,
    type SavedView,
    type SavedViews,
} from "@/lib/board-url";
import { shouldHoldReorder } from "@/lib/motion";
import { AttentionSection } from "@/components/board/AttentionSection";
import { BoardHeader } from "@/components/board/BoardHeader";
import { BoardSkeleton, EmptyBoard, LoadFailed, NoMatches } from "@/components/board/BoardStates";
import { BoardTree } from "@/components/board/BoardTree";
import {
    BoardActionsContext,
    BoardViewContext,
    type BoardActions,
    type BoardView,
} from "@/components/board/board-context";
import { Select } from "@/components/ui/select";
import { DetailPane, WIDE_QUERY } from "@/components/board/DetailPane";
import { FilterPopover } from "@/components/board/FilterPopover";
import { MotionProvider } from "@/components/board/MotionProvider";
import { SelectionBar } from "@/components/board/SelectionBar";
import { StatusSummary } from "@/components/board/StatusSummary";
import { useBoardData } from "@/components/board/useBoardData";
import { useIdleCalm } from "@/components/board/useIdleCalm";
import { ViewsMenu } from "@/components/board/ViewsMenu";

const COLLAPSED_KEY = "flatline.collapsedGroups";

function readCollapsed(): Set<number> {
    try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        return new Set(raw ? (JSON.parse(raw) as number[]) : []);
    } catch {
        return new Set();
    }
}

/** Where the board starts: the URL if it carries board state, else the default saved view. */
function initialBoardState(): { filter: FilterState; sort: SortKey; open: number | null } {
    const fromUrl = parseBoardQuery(window.location.search);
    if (fromUrl.hasParams) {
        return fromUrl;
    }
    const views = loadViews(window.localStorage);
    const def = views.views.find((v) => v.id === views.defaultId);
    return def ? { filter: def.filter, sort: def.sort, open: null } : fromUrl;
}

function useMedia(query: string): boolean {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const list = window.matchMedia(query);
        const onChange = () => setMatches(list.matches);
        list.addEventListener("change", onChange);
        onChange();
        return () => list.removeEventListener("change", onChange);
    }, [query]);
    return matches;
}

/**
 * The operator dashboard: token gate, then the board.
 *
 * Header, status summary, a pinned "Needs attention" list, the group tree
 * (worst first by default) and a detail pane. The data layer lives in
 * `board/useBoardData`, the pure rules in `lib/board-*`.
 */
export function Dashboard() {
    const [authed, setAuthed] = useState(() => Boolean(getToken()));
    const disconnect = useCallback(() => {
        setToken(null);
        setAuthed(false);
    }, []);
    const data = useBoardData(authed, disconnect);
    const { monitors, rosterLoaded } = data;

    const initial = useRef(initialBoardState()).current;
    const [filter, setFilter] = useState<FilterState>(initial.filter);
    const [sort, setSort] = useState<SortKey>(initial.sort);
    const [detailId, setDetailId] = useState<number | null>(initial.open);
    const [density, setDensityState] = useState<Density>(() => loadDensity(window.localStorage));
    const [views, setViews] = useState<SavedViews>(() => loadViews(window.localStorage));
    const [collapsed, setCollapsed] = useState<Set<number>>(readCollapsed);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [cursorId, setCursorId] = useState<number | null>(null);
    const [pointerOverList, setPointerOverList] = useState(false);
    const [menu, setMenu] = useState<MenuAnchor | null>(null);
    const [renaming, setRenaming] = useState<MonitorSummary | null>(null);
    const [moving, setMoving] = useState<MonitorSummary | null>(null);
    const [deletingGroup, setDeletingGroup] = useState<{
        group: MonitorSummary;
        rows: number;
        children: number;
    } | null>(null);
    const [busy, setBusy] = useState(false);
    const [formState, setFormState] = useState<
        | { mode: "create"; initial?: Partial<MonitorSummary> & Record<string, unknown> }
        | { mode: "edit"; monitor: MonitorSummary & Record<string, unknown> }
        | null
    >(null);
    const [agentsOpen, setAgentsOpen] = useState(false);

    const calm = useIdleCalm();
    const wide = useMedia(WIDE_QUERY);

    // ---- derived board ----------------------------------------------------

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

    // While the pointer is over the list, a selection exists or a menu is open,
    // a status-driven reorder waits: sort keys come from the last free snapshot
    // while rows keep showing live data.
    const hold = shouldHoldReorder({
        pointerOverList,
        selectionSize: selected.size,
        menuOpen: menu !== null,
    });
    const basisRef = useRef<Map<number, MonitorSummary>>(new Map());
    if (!hold || basisRef.current.size === 0) {
        basisRef.current = new Map(monitors.map((m) => [m.id, m]));
    }
    const basis = hold ? basisRef.current : undefined;

    const board = useMemo(
        () => buildBoard(monitors, { sort, filter, attentionIds, basis, strips: data.strips }),
        [monitors, sort, filter, attentionIds, basis, data.strips]
    );
    const totals = useMemo(() => boardTotals(monitors), [monitors]);
    const facets = useMemo(() => filterFacets(monitors), [monitors]);
    const forceOpen = isFilterActive(filter);
    const shownCount = useMemo(
        () => visibleRowIds(board, collapsed, true).filter((r) => r.kind === "monitor").length,
        [board, collapsed]
    );
    const rowOrder = useMemo(() => visibleRowIds(board, collapsed, forceOpen), [board, collapsed, forceOpen]);

    // ---- persistence and URL ---------------------------------------------

    useEffect(() => {
        storeViews(window.localStorage, views);
    }, [views]);

    const setDensity = useCallback((next: Density) => {
        setDensityState(next);
        try {
            window.localStorage.setItem(DENSITY_KEY, next);
        } catch {
            // Storage can be unavailable; the choice just will not persist.
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            const search = serializeBoardQuery({ filter, sort, open: detailId }, window.location.search);
            if (search !== window.location.search) {
                window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
            }
        }, 250);
        return () => window.clearTimeout(timer);
    }, [filter, sort, detailId]);

    // ---- actions ----------------------------------------------------------

    const openMonitor = useCallback((id: number) => {
        setAgentsOpen(false);
        setDetailId(id);
        setCursorId(id);
    }, []);
    const closeDetail = useCallback(() => setDetailId(null), []);

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

    const openMenu = useCallback((monitor: MonitorSummary, x: number, y: number) => setMenu({ x, y, monitor }), []);

    // Handlers behind a stable object so memoised rows do not re-render when the closures change.
    const latest = useRef<BoardActions>({ openMonitor, toggleSelect, toggleGroup, openMenu });
    latest.current = { openMonitor, toggleSelect, toggleGroup, openMenu };
    const actions = useMemo<BoardActions>(
        () => ({
            openMonitor: (id) => latest.current.openMonitor(id),
            toggleSelect: (id) => latest.current.toggleSelect(id),
            toggleGroup: (id) => latest.current.toggleGroup(id),
            openMenu: (monitor, x, y) => latest.current.openMenu(monitor, x, y),
        }),
        []
    );

    const clearFilters = useCallback(() => setFilter(EMPTY_FILTER), []);
    const toggleStatus = useCallback(
        (status: StatusKey) =>
            setFilter((prev) => ({
                ...prev,
                status: prev.status.includes(status)
                    ? prev.status.filter((s) => s !== status)
                    : [...prev.status, status],
            })),
        []
    );
    const applyView = useCallback((view: SavedView) => {
        setFilter(view.filter);
        setSort(view.sort);
    }, []);

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
            await data.reload();
        } catch (e) {
            data.setError(e instanceof Error ? e.message : "Action failed.");
        } finally {
            setBusy(false);
        }
    }

    // ---- keyboard ---------------------------------------------------------

    const overlayOpen =
        menu !== null || renaming !== null || moving !== null || deletingGroup !== null || formState !== null;
    const keyState = useRef({ rowOrder, cursorId, detailId, selected, filter, overlayOpen, toggleGroup });
    keyState.current = { rowOrder, cursorId, detailId, selected, filter, overlayOpen, toggleGroup };

    useEffect(() => {
        if (!authed) {
            return;
        }
        function focusRow(id: number) {
            setCursorId(id);
            const el = document.querySelector<HTMLElement>(`[data-row-main="${id}"]`);
            el?.focus({ preventScroll: true });
            el?.scrollIntoView({ block: "nearest" });
        }
        function onKey(event: KeyboardEvent) {
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            const state = keyState.current;
            const target = event.target as HTMLElement | null;
            const typing =
                target?.tagName === "INPUT" ||
                target?.tagName === "TEXTAREA" ||
                target?.tagName === "SELECT" ||
                target?.isContentEditable === true;
            // Checkboxes are inputs but not text entry: shortcuts still apply there.
            const textEntry = typing && !(target instanceof HTMLInputElement && target.type === "checkbox");

            if (event.key === "Escape") {
                if (state.overlayOpen || document.querySelector("[data-popover-open]")) {
                    return;
                }
                if (textEntry) {
                    if (target?.id === "monitor-search") {
                        setFilter((prev) => ({ ...prev, q: "" }));
                    }
                    target?.blur();
                    return;
                }
                if (state.detailId !== null) {
                    setDetailId(null);
                } else if (state.selected.size > 0) {
                    setSelected(new Set());
                } else if (isFilterActive(state.filter)) {
                    setFilter(EMPTY_FILTER);
                }
                return;
            }
            if (textEntry || state.overlayOpen) {
                return;
            }
            if (event.key === "/") {
                event.preventDefault();
                document.getElementById("monitor-search")?.focus();
                return;
            }
            const order = state.rowOrder;
            if (event.key === "j" || event.key === "k") {
                if (order.length === 0) {
                    return;
                }
                event.preventDefault();
                const at = order.findIndex((r) => r.id === state.cursorId);
                const next = event.key === "j" ? Math.min(order.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
                focusRow(order[next].id);
                return;
            }
            const current = order.find((r) => r.id === state.cursorId);
            if (!current) {
                return;
            }
            if (event.key === "x" && current.kind === "monitor") {
                event.preventDefault();
                setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(current.id)) {
                        next.delete(current.id);
                    } else {
                        next.add(current.id);
                    }
                    return next;
                });
            } else if (
                event.key === "Enter" &&
                !(target instanceof HTMLButtonElement) &&
                !(target instanceof HTMLAnchorElement)
            ) {
                event.preventDefault();
                if (current.kind === "group") {
                    state.toggleGroup(current.id);
                } else {
                    setAgentsOpen(false);
                    setDetailId(current.id);
                }
            }
        }
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [authed]);

    // ---- menus and dialogs ------------------------------------------------

    const groupChoices = useMemo(
        () =>
            groupOptions(
                monitors,
                formState?.mode === "edit" && formState.monitor.type === "group" ? formState.monitor.id : null
            ),
        [monitors, formState]
    );
    const linkCandidates = useMemo(
        () => buildLinkCandidates(monitors, formState?.mode === "edit" ? formState.monitor.id : null),
        [monitors, formState]
    );

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
            await data.reload();
        } catch (e) {
            data.setError(e instanceof Error ? e.message : "Delete failed.");
            setDeletingGroup(null);
        } finally {
            setBusy(false);
        }
    }

    // ---- render -----------------------------------------------------------

    const lastDetail = useRef<number | null>(detailId);
    if (detailId !== null) {
        lastDetail.current = detailId;
    }

    const view: BoardView = {
        density,
        calm,
        strips: data.strips,
        selected,
        collapsed,
        forceOpen,
        openId: detailId,
        menuId: menu?.monitor.id ?? null,
        cursorId,
        cueRows: data.cue.rows,
        cueSeq: data.cue.seq,
        now: data.now,
    };

    if (!authed) {
        return <TokenGate onSaved={() => setAuthed(true)} />;
    }

    const filtering = isFilterActive(filter);
    const hasRows = board.roots.length > 0 || board.ungrouped.length > 0;

    return (
        <MotionProvider>
            <div className="flex min-h-screen">
                <div className="min-w-0 flex-1">
                    <div className="mx-auto max-w-[1200px]">
                        <BoardHeader
                            query={filter.q}
                            onQuery={(q) => setFilter((prev) => ({ ...prev, q }))}
                            matchCount={filtering ? shownCount : null}
                            total={totals.total}
                            filters={
                                <>
                                    <FilterPopover
                                        filter={filter}
                                        onChange={setFilter}
                                        types={facets.types}
                                        tags={facets.tags}
                                        attentionCount={attentionIds.size}
                                    />
                                    <ViewsMenu
                                        state={views}
                                        onChange={setViews}
                                        onApply={applyView}
                                        filter={filter}
                                        sort={sort}
                                    />
                                </>
                            }
                            density={density}
                            onDensity={setDensity}
                            paused={data.paused}
                            onTogglePaused={() => data.setPaused(!data.paused)}
                            onNewMonitor={() => setFormState({ mode: "create" })}
                            onNewGroup={() => setFormState({ mode: "create", initial: { type: "group" } })}
                            onSuperboard={() => navigate("/superboard")}
                            onAgents={() => {
                                setDetailId(null);
                                setAgentsOpen((v) => !v);
                            }}
                            onDisconnect={disconnect}
                        />

                        {data.error ? (
                            <div
                                role="status"
                                className="mx-6 mb-3 rounded-md bg-destructive/10 px-4 py-2 text-xs text-destructive"
                            >
                                {data.error}
                            </div>
                        ) : null}

                        {agentsOpen ? (
                            <AgentPanel
                                onClose={() => {
                                    setAgentsOpen(false);
                                    void data.reload();
                                }}
                            />
                        ) : (
                            <main className="space-y-4 px-6 pb-28">
                                {rosterLoaded ? (
                                    <>
                                        <StatusSummary
                                            totals={totals}
                                            attention={attention}
                                            active={filter.status}
                                            onToggleStatus={toggleStatus}
                                            cue={data.cue}
                                            calm={calm}
                                            paused={data.paused}
                                            pending={data.pending}
                                            onResume={() => data.setPaused(false)}
                                        />
                                        <AttentionSection items={attention} onOpen={openMonitor} calm={calm} />
                                    </>
                                ) : null}

                                <section
                                    aria-label="Monitors"
                                    className="rounded-lg border border-border bg-surface/40"
                                >
                                    <div className="flex items-center gap-3 px-5 py-3">
                                        <h2 className="text-sm font-semibold">Monitors</h2>
                                        {rosterLoaded ? (
                                            <span className="tnum text-xs text-quiet">{totals.total}</span>
                                        ) : null}
                                        <label className="ml-auto flex items-center gap-2 text-xs text-quiet">
                                            Sort
                                            <Select
                                                size="sm"
                                                aria-label="Sort"
                                                className="w-36"
                                                value={sort}
                                                onChange={(next) => setSort(next as SortKey)}
                                                options={SORT_KEYS.map((option) => ({
                                                    value: option.key,
                                                    label: option.label,
                                                }))}
                                            />
                                        </label>
                                    </div>

                                    <BoardActionsContext.Provider value={actions}>
                                        <BoardViewContext.Provider value={view}>
                                            <div
                                                className="board-list border-t border-border"
                                                data-density={density}
                                                data-strips={data.strips.size > 0 ? "on" : "off"}
                                                data-selecting={selected.size > 0 || undefined}
                                                onPointerEnter={() => setPointerOverList(true)}
                                                onPointerLeave={() => setPointerOverList(false)}
                                            >
                                                {!rosterLoaded ? (
                                                    data.error ? (
                                                        <LoadFailed
                                                            message={data.error}
                                                            onRetry={() => void data.reload()}
                                                        />
                                                    ) : (
                                                        <BoardSkeleton />
                                                    )
                                                ) : monitors.length === 0 ? (
                                                    <EmptyBoard onNewMonitor={() => setFormState({ mode: "create" })} />
                                                ) : !hasRows ? (
                                                    <NoMatches onClear={clearFilters} />
                                                ) : (
                                                    <BoardTree board={board} />
                                                )}
                                            </div>
                                        </BoardViewContext.Provider>
                                    </BoardActionsContext.Provider>

                                    {rosterLoaded && hasRows ? (
                                        <p className="board-hint hidden border-t border-border px-5 py-2.5 text-[11px] text-quiet md:block">
                                            <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open
                                            · <kbd>x</kbd> select · <kbd>Esc</kbd> close or clear
                                        </p>
                                    ) : null}
                                </section>
                            </main>
                        )}
                    </div>
                </div>

                {wide ? (
                    <DetailPane open={detailId !== null && !agentsOpen} wide onClose={closeDetail} calm={calm}>
                        {lastDetail.current !== null ? (
                            <MonitorDetail
                                id={lastDetail.current}
                                compact
                                onBack={closeDetail}
                                onEdit={(monitor) => setFormState({ mode: "edit", monitor })}
                            />
                        ) : null}
                    </DetailPane>
                ) : null}
            </div>

            {!wide ? (
                <DetailPane open={detailId !== null && !agentsOpen} wide={false} onClose={closeDetail} calm={calm}>
                    {lastDetail.current !== null ? (
                        <MonitorDetail
                            id={lastDetail.current}
                            compact
                            onBack={closeDetail}
                            onEdit={(monitor) => setFormState({ mode: "edit", monitor })}
                        />
                    ) : null}
                </DetailPane>
            ) : null}

            <SelectionBar
                count={selected.size}
                busy={busy}
                onAction={(action) => void applyToSelection(action)}
                onClear={() => setSelected(new Set())}
            />

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
                                void data.reload();
                            }}
                            onCancel={() => setFormState(null)}
                        />
                    </div>
                </div>
            ) : null}
        </MotionProvider>
    );
}
