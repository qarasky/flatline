import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ApiError,
    clearAgentWarnings,
    fetchBulkMonitorLinks,
    fetchLatestMetricsBulk,
    fetchAllMonitors,
    getToken,
    setToken,
    type MonitorLinks,
    type MonitorSummary,
    type ResolvedMonitorLink,
} from "@/lib/api";
import { subscribeLive } from "@/lib/live-hub";
import { navigate } from "@/lib/router";
import { TokenGate } from "@/components/TokenGate";
import { FleetCard, type FleetServer } from "@/components/FleetCard";
import { RenameDialog, ServerMenu, type MenuAnchor, type MenuItem } from "@/components/ServerMenu";
import { WebsiteLinkDialog } from "@/components/WebsiteLinks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentWarningCounts, fleetAttention, matchGroups } from "@/lib/fleet-presentation";
import { fleetPageSize } from "@/lib/fleet-layout";
import { ServerHistory } from "@/components/ServerHistory";

/** Minimum card footprint used to work out how many fit on the wall. */
const MIN_CARD_W = 340;
const MIN_CARD_H = 420;
const GAP = 8;

/** How long the board stays paused after someone touches it. */
const IDLE_RESUME_MS = 30_000;

/**
 * Parse an integer query parameter, clamped to a range.
 * @param params URL search params
 * @param key Parameter name
 * @param fallback Value when absent or invalid
 * @param min Lower bound
 * @param max Upper bound
 * @returns The clamped integer
 */
function intParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
    const raw = params.get(key);
    if (raw === null || !/^[0-9]+$/.test(raw)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Number(raw)));
}

/**
 * Open monitors' metrics as board entries in one request.
 *
 * A null sample is not an error: it is exactly how the board discovers which
 * monitors are servers. Any transport failure propagates.
 * @param monitors Roster entries with metrics candidates
 * @param signal Cancels the bulk requests when the snapshot deadline fires
 * @returns One entry per monitor that has a sample
 */
async function toFleetServers(monitors: MonitorSummary[], signal?: AbortSignal): Promise<FleetServer[]> {
    if (monitors.length === 0) {
        return [];
    }

    const samples = {} as Record<
        number,
        { time: string; metrics: FleetServer["metrics"]; cpuPeak10m?: FleetServer["cpuPeak10m"] } | null
    >;
    const batches = Array.from({ length: Math.ceil(monitors.length / 200) }, (_, index) =>
        fetchLatestMetricsBulk(
            monitors.slice(index * 200, (index + 1) * 200).map((m) => m.id),
            signal
        )
    );
    for (const batch of await Promise.all(batches)) {
        Object.assign(samples, batch.samples);
    }
    const out: FleetServer[] = [];

    for (const monitor of monitors) {
        const sample = samples[monitor.id];
        if (sample) {
            out.push({ monitor, time: sample.time, metrics: sample.metrics, cpuPeak10m: sample.cpuPeak10m });
        }
    }

    return out;
}

/**
 * Wall clock for the kiosk view.
 *
 * Only mounted in kiosk mode: the desk board does not need a running clock,
 * and a per-second re-render is not free.
 */
function Clock() {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    return (
        <span className="tnum text-sm text-quiet">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
    );
}

/**
 * The board itself: fleet cards, auto-pagination, and the kiosk chrome.
 *
 * When `filter` is set (a comma-separated group scope from the URL), only
 * servers whose parent group matches stay on the board, including live
 * arrivals. Unknown scopes match nothing rather than everything.
 */
function Superboard({
    kiosk,
    filter,
    onDisconnect,
}: {
    kiosk: boolean;
    filter: string | null;
    onDisconnect: () => void;
}) {
    const [servers, setServers] = useState<FleetServer[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    const [page, setPage] = useState(0);
    const [paused, setPaused] = useState(false);
    const [layout, setLayout] = useState({ cols: 3, rows: 2 });
    const [visible, setVisible] = useState(() => !document.hidden);
    const [now, refreshFreshness] = useState(Date.now);
    const [historyId, setHistoryId] = useState<number | null>(null);
    const openHistory = useCallback((id: number) => setHistoryId(id), []);
    const closeHistory = useCallback(() => setHistoryId(null), []);
    const historyMonitor = servers.find((server) => server.monitor.id === historyId)?.monitor;
    // Custom right-click menu and the rename dialog it opens. Either open
    // pauses rotation like an open history dialog does.
    const [menu, setMenu] = useState<MenuAnchor | null>(null);
    const [renaming, setRenaming] = useState<{ monitor: MonitorSummary; name: string } | null>(null);
    const [linkServer, setLinkServer] = useState<MonitorSummary | null>(null);
    const openMenu = useCallback((e: React.MouseEvent, monitor: MonitorSummary) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, monitor });
    }, []);

    // Menu contents for the current anchor. "Clear agent warnings" only
    // appears while the card is showing one, so a clean card carries no
    // noise. Clearing acknowledges every agent counter on the server (the
    // agent has no control channel) and the invalidate resnapshots.
    const menuItems: MenuItem[] = useMemo(() => {
        if (!menu) {
            return [];
        }
        const server = servers.find((s) => s.monitor.id === menu.monitor.id);
        const items: MenuItem[] = [
            {
                label: "Rename…",
                onSelect: () => {
                    const name = server
                        ? server.monitor.name || server.metrics.host?.hostname || "Unnamed server"
                        : menu.monitor.name;
                    setRenaming({ monitor: menu.monitor, name });
                    setMenu(null);
                },
            },
            {
                label: "Manage websites…",
                onSelect: () => {
                    setLinkServer(menu.monitor);
                    setMenu(null);
                },
            },
        ];

        // The same counts the card prints, from the latest sample the board
        // already holds, so the menu and the warning line agree.
        const monitor = server?.monitor ?? menu.monitor;
        const warnings = agentWarningCounts(server?.metrics.agent, monitor).total;
        if (menu.monitor.type === "push" && warnings > 0) {
            items.push({
                label: `Clear agent warnings (${warnings})`,
                onSelect: () => {
                    setMenu(null);
                    void clearAgentWarnings(menu.monitor.id).catch((failure) => {
                        setError(failure instanceof Error ? failure.message : "Clear failed.");
                    });
                },
            });
        }
        return items;
    }, [menu, servers]);
    // Resolved scope names for the wall header; raw filter when unresolvable.
    const [scopeNames, setScopeNames] = useState<string[]>([]);
    const scopeTitle = scopeNames.length > 0 ? scopeNames.join(", ") : filter;

    // Freshness must age even when the last/only host stops sending.
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                refreshFreshness(Date.now());
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);

    const gridRef = useRef<HTMLDivElement>(null);
    const resumeTimer = useRef<number | undefined>(undefined);

    const params = useMemo(() => new URLSearchParams(window.location.search), []);
    const rotateMs = intParam(params, "rotate", 5, 1, 300) * 1000;
    const rawPerPage = intParam(params, "perPage", 0, 1, 200);
    const overridePerPage = params.has("perPage") && rawPerPage > 0 ? rawPerPage : null;

    // -- data ---------------------------------------------------------------

    useEffect(() => {
        let alive = true;
        let roster = new Map<number, MonitorSummary>();
        // Group scope for this board, recomputed on every snapshot: a group
        // rename takes effect on the next (re)connect, same as ordering.
        let scopeIds: Set<number> | null = null;
        const order = (a: FleetServer, b: FleetServer) =>
            (roster.get(a.monitor.parent ?? -1)?.weight ?? 0) - (roster.get(b.monitor.parent ?? -1)?.weight ?? 0) ||
            (a.monitor.weight ?? 0) - (b.monitor.weight ?? 0) ||
            a.monitor.name.localeCompare(b.monitor.name);

        async function load(signal?: AbortSignal) {
            try {
                const monitors = await fetchAllMonitors(signal);
                roster = new Map(monitors.map((m) => [m.id, m]));
                const matched = filter ? matchGroups(monitors, filter) : [];
                scopeIds = filter ? new Set(matched.map((g) => g.id)) : null;

                // Groups are containers, not servers; anything else that has
                // recent metrics is one. Zero configuration, and a server that
                // stops pushing ages out of the board on its own. One bulk
                // request, not one per monitor, so the board sips the rate
                // budget instead of drinking it. A group scope narrows the
                // candidates to that group's children; ungrouped monitors
                // never match a scope.
                const candidates = monitors.filter(
                    (m) =>
                        m.type !== "group" &&
                        m.active !== false &&
                        (!scopeIds || (m.parent != null && scopeIds.has(m.parent)))
                );
                const next = await toFleetServers(candidates, signal);

                // Hosted-website links, fetched in the same batches as metrics:
                // one request per 200 servers, never one per card.
                const linkBatches = Array.from({ length: Math.ceil(next.length / 200) }, (_, index) =>
                    fetchBulkMonitorLinks(
                        next.slice(index * 200, (index + 1) * 200).map((s) => s.monitor.id),
                        signal
                    )
                );
                const linkServers: Record<string, MonitorLinks> = {};
                for (const batch of await Promise.all(linkBatches)) {
                    Object.assign(linkServers, batch.servers);
                }
                for (const server of next) {
                    server.links = linkServers[String(server.monitor.id)]?.resolved ?? [];
                }

                if (!alive) {
                    return;
                }

                setScopeNames(matched.map((g) => g.name));
                // Operator-controlled order: parent group weight, then the
                // monitor's own weight, then name. Ties fall back to name so
                // the board never reshuffles between refreshes.
                next.sort(order);

                setServers(next);
                setError(null);
            } catch (e) {
                if (!alive) {
                    return;
                }
                if (e instanceof ApiError && e.status === 401) {
                    onDisconnect();
                    return;
                }
                setError(e instanceof Error ? e.message : "Could not load the board.");
                throw e;
            } finally {
                if (alive) {
                    setLoaded(true);
                }
            }
        }

        // Always load once, even if the tab is hidden at mount: a kiosk that
        // wakes up foregrounded must never flash "no servers" because the
        // first fetch was cancelled by a visibility change. The interval,
        // however, skips hidden ticks — no point polling a board nobody sees.
        const stop = subscribeLive({
            snapshot: load,
            event: (event) => {
                if (!alive) {
                    return;
                }
                const monitor = roster.get(event.monitorId);
                if (event.type === "heartbeat" && monitor) {
                    roster.set(event.monitorId, { ...monitor, ...event.patch });
                }
                if (event.type === "metrics") {
                    const current = roster.get(event.monitorId);
                    if (scopeIds && !(current && current.parent != null && scopeIds.has(current.parent))) {
                        return;
                    }
                }
                setServers((previous) => {
                    if (
                        event.type === "metrics" &&
                        !previous.some((s) => s.monitor.id === event.monitorId) &&
                        monitor?.active &&
                        monitor.type !== "group"
                    ) {
                        return [
                            ...previous,
                            {
                                monitor,
                                time: event.time,
                                metrics: event.metrics,
                                cpuPeak10m: event.cpuPeak10m,
                                links: [],
                            },
                        ].sort(order);
                    }
                    return previous.map((server) => {
                        let next = server;
                        if (server.monitor.id === event.monitorId) {
                            next =
                                event.type === "metrics"
                                    ? {
                                          ...server,
                                          time: event.time,
                                          metrics: event.metrics,
                                          cpuPeak10m: event.cpuPeak10m,
                                      }
                                    : { ...server, monitor: { ...server.monitor, ...event.patch } };
                        }
                        // A linked website's heartbeat updates its chip on every
                        // server that hosts it, without refetching the links.
                        if (event.type === "heartbeat" && next.links?.some((link) => link.id === event.monitorId)) {
                            const patch = event.patch;
                            const links: ResolvedMonitorLink[] = next.links.map((link) =>
                                link.id === event.monitorId
                                    ? {
                                          ...link,
                                          status: patch.status ?? link.status,
                                          ping: patch.ping ?? link.ping,
                                          lastCheck: patch.lastCheck ?? link.lastCheck,
                                      }
                                    : link
                            );
                            next = { ...next, links };
                        }
                        return next;
                    });
                });
                setError(null);
            },
            error: (error) => {
                if (!alive) {
                    return;
                }
                if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                    onDisconnect();
                    return;
                }
                setError("Live updates disconnected; reconnecting. Last readings remain visible.");
                // A metrics-free/new host is discovered on reconnect snapshot.
            },
        });
        return () => {
            alive = false;
            stop();
        };
    }, [onDisconnect, filter]);

    // Pause work while the tab is hidden; resume when it comes back.
    useEffect(() => {
        const onVisibility = () => setVisible(!document.hidden);
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    // -- how many cards fit -------------------------------------------------

    useEffect(() => {
        const el = gridRef.current;
        if (!el) {
            return;
        }

        const measure = () => {
            const cols = Math.max(1, Math.floor((el.clientWidth + GAP) / (MIN_CARD_W + GAP)));
            // Content-sized cards can be taller with GPUs or long names.
            // Measure them rather than packing rows against an assumed height.
            const cardHeight = Math.max(
                MIN_CARD_H,
                ...Array.from(el.children).map((card) => card.getBoundingClientRect().height)
            );
            const rows = Math.max(1, Math.floor((el.clientHeight + GAP) / (cardHeight + GAP)));
            setLayout((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        Array.from(el.children).forEach((card) => observer.observe(card));
        return () => observer.disconnect();
    }, [servers.length]);

    // A tall GPU card must not force eight hosts onto rotating single rows.
    // Pack at least ten per page; CSS uses additional rows/scrolling as needed.
    const perPage = fleetPageSize(layout.cols, layout.rows, overridePerPage);
    const pageCount = Math.max(1, Math.ceil(servers.length / perPage));
    const pageServers = servers.slice(page * perPage, page * perPage + perPage);

    // Keep the page in range as the fleet or the viewport changes.
    useEffect(() => {
        if (page >= pageCount) {
            setPage(0);
        }
    }, [page, pageCount]);

    // -- rotation -----------------------------------------------------------

    useEffect(() => {
        if (
            paused ||
            !visible ||
            pageCount <= 1 ||
            historyId !== null ||
            menu !== null ||
            renaming !== null ||
            linkServer !== null
        ) {
            return;
        }
        const timer = window.setInterval(() => setPage((p) => (p + 1) % pageCount), rotateMs);
        return () => window.clearInterval(timer);
    }, [paused, visible, pageCount, rotateMs, historyId, menu, renaming, linkServer]);

    /** Any interaction pauses rotation for a while, so investigation is possible. */
    function noteInteraction() {
        setPaused(true);
        window.clearTimeout(resumeTimer.current);
        resumeTimer.current = window.setTimeout(() => setPaused(false), IDLE_RESUME_MS);
    }

    useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

    const down = servers.filter((s) => s.monitor.status === 0).length;
    const attentionCount = servers.filter((s) => {
        const state = fleetAttention(s.metrics, s.time, s.monitor.interval || 60);
        const websiteDown = s.links?.some((link) => link.status === 0) ?? false;
        return (
            s.monitor.status === 0 ||
            s.monitor.status === 2 ||
            state.stale ||
            state.issues > 0 ||
            state.hot ||
            websiteDown
        );
    }).length;
    const rotated = pageCount > 1;

    const position = (
        <span className="tnum text-xs text-quiet">
            {page + 1} / {pageCount}
            {paused && rotated ? <span className="ml-2 font-semibold text-warn">paused</span> : null}
        </span>
    );

    // -- render -------------------------------------------------------------

    const content =
        loaded && servers.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-lg font-semibold">
                    {filter ? `No servers in scope “${scopeTitle}”.` : "No servers reporting yet."}
                </p>
                <p className="max-w-md text-sm text-quiet">
                    {filter
                        ? "Check the group name in the URL, or link these monitors to a group in the admin panel."
                        : "Install the Superboard agent on a box, or POST metrics to a push monitor. Any monitor that sends a metrics sample shows up here automatically."}
                </p>
            </div>
        ) : (
            <div
                ref={gridRef}
                className="fleet-grid grid min-h-0 flex-1 items-start content-start gap-2 overflow-y-auto"
                style={{
                    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                }}
            >
                {pageServers.map((server) => (
                    <FleetCard
                        key={server.monitor.id}
                        server={server}
                        now={now}
                        onOpenHistory={openHistory}
                        onMenu={openMenu}
                    />
                ))}
            </div>
        );

    const body = (
        <div
            className="superboard flex h-full min-h-0 flex-col"
            data-kiosk={kiosk || undefined}
            onPointerDown={noteInteraction}
            onKeyDown={noteInteraction}
            onTouchStart={noteInteraction}
        >
            {kiosk ? (
                <div className="flex items-center justify-between px-4 py-2">
                    <span className="text-sm font-semibold tracking-tight">
                        Flatline <span className="font-normal text-quiet">Superboard</span>
                        {filter ? <span className="font-normal text-quiet"> · {scopeTitle}</span> : null}
                    </span>
                    <span className="flex items-center gap-4">
                        {down > 0 ? (
                            <Badge tone="down">
                                <span className="size-1.5 rounded-full bg-current" />
                                {down} down
                            </Badge>
                        ) : (
                            <Badge tone={attentionCount > 0 ? "degraded" : "neutral"}>
                                <span className="size-1.5 rounded-full bg-current" />
                                {attentionCount > 0 ? `${attentionCount} need attention` : "All hosts up"}
                            </Badge>
                        )}
                        {position}
                        <Clock />
                    </span>
                </div>
            ) : (
                <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                    <button
                        type="button"
                        className="text-sm font-semibold tracking-tight hover:text-primary"
                        onClick={() => navigate("/")}
                    >
                        ← Flatline
                    </button>
                    <span className="text-sm text-quiet">Superboard</span>
                    {filter ? <span className="text-xs text-quiet">· {scopeTitle}</span> : null}
                    <span className="text-xs text-quiet">
                        <span className="tnum">{servers.length}</span> {servers.length === 1 ? "server" : "servers"}
                        {down > 0 ? <span className="ml-1 font-semibold text-bad">· {down} down</span> : null}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                        {position}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                navigate(filter ? `/superboard/kiosk/${encodeScope(filter)}` : "/superboard/kiosk")
                            }
                        >
                            Kiosk
                        </Button>
                        <Button size="sm" variant="ghost" title="Forget token" onClick={onDisconnect}>
                            Disconnect
                        </Button>
                    </div>
                </div>
            )}

            {error ? (
                <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error}
                </div>
            ) : null}

            <div className={`flex min-h-0 flex-1 flex-col p-4 ${kiosk ? "pt-0" : ""}`}>{content}</div>
            {historyMonitor ? <ServerHistory monitor={historyMonitor} onClose={closeHistory} /> : null}
            {menu ? <ServerMenu anchor={menu} items={menuItems} onClose={() => setMenu(null)} /> : null}
            {renaming ? (
                <RenameDialog
                    monitor={renaming.monitor}
                    currentName={renaming.name}
                    onClose={() => setRenaming(null)}
                />
            ) : null}
            {linkServer ? <WebsiteLinkDialog server={linkServer} onClose={() => setLinkServer(null)} /> : null}
        </div>
    );

    // Kiosk fills the viewport and does not scroll: the wall URL is opened
    // fullscreen and must never show a scrollbar.
    return kiosk ? (
        <div className="h-screen w-screen overflow-hidden">{body}</div>
    ) : (
        <div className="h-screen">{body}</div>
    );
}

/**
 * Encode a raw group scope back into a URL segment, keeping commas as the
 * multi-group delimiter.
 */
function encodeScope(filter: string): string {
    return filter
        .split(",")
        .map((part) => encodeURIComponent(part.trim()))
        .join(",");
}

/**
 * Superboard entry point: auth gate plus the board.
 *
 * Auth is the same bearer-token model as the dashboard, so the board inherits
 * every scope rule without a second login.
 * @param props.kiosk Render chrome-free for a wall display
 * @param props.filter Group scope from the URL, or null for the whole fleet
 */
export function SuperboardApp({ kiosk, filter }: { kiosk: boolean; filter: string | null }) {
    const [authed, setAuthed] = useState(() => Boolean(getToken()));

    const disconnect = useCallback(() => {
        setToken(null);
        setAuthed(false);
    }, []);

    if (!authed) {
        return <TokenGate onSaved={() => setAuthed(true)} />;
    }

    return <Superboard kiosk={kiosk} filter={filter} onDisconnect={disconnect} />;
}
