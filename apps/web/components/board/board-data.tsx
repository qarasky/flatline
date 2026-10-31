"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import { agentWarnings } from "@/lib/fleet-presentation";
import {
    STRIP_BUCKETS,
    STRIP_HOURS,
    alignStrip,
    blankStrip,
    chunkIds,
    parseTime,
    placeBeat,
    stripsFromResponse,
    type Strip,
} from "@/lib/heartbeat-strip";
import { EventBatcher, applyPatches, changedStatusIds, coalesceBeats, type LiveBeat } from "@/lib/live-batch";
import { subscribeLive } from "@/lib/live-hub";
import type { BackupAgentSummary, MonitorSummary } from "@/lib/monitor-types";
import {
    fetchAllBackupAgents,
    fetchAllMonitors,
    fetchHeartbeatStrips,
    fetchLatestMetricsBulk,
} from "@/lib/monitors-api";
import { HIGHLIGHT_MS, LIVE_BATCH_MS, planCues } from "@/lib/motion";
import { PASSWORD_PATH, SIGN_IN_PATH } from "@/lib/session";

/** Which rows get a highlight after the latest batch, or the one group cue. */
export interface Cue {
    seq: number;
    rows: Set<number>;
    group: boolean;
    /** How many monitors changed status in the batch. */
    changed: number;
}

const NO_CUE: Cue = { seq: 0, rows: new Set(), group: false, changed: 0 };

export interface BoardData {
    monitors: MonitorSummary[];
    rosterLoaded: boolean;
    /** The live stream's first snapshot has landed. */
    ready: boolean;
    error: string | null;
    setError: (message: string | null) => void;
    /** Strips aligned to the current time; empty when the endpoint is unavailable. */
    strips: Map<number, Strip>;
    changedAt: Map<number, number>;
    agentWarnings: Map<number, string>;
    backups: BackupAgentSummary[];
    cue: Cue;
    now: number;
    paused: boolean;
    setPaused: (paused: boolean) => void;
    /** Live changes waiting while paused. */
    pending: number;
    /** Refresh the roster now, even while paused (after an operator action). */
    reload: () => Promise<void>;
}

/**
 * The ended session's way out: a page whose live stream or roster read was
 * refused goes to sign-in (or to the password page), once.
 */
function leave(error: ApiError): void {
    if (error.code === "password_change_required") {
        window.location.assign(PASSWORD_PATH);
        return;
    }
    const here = window.location.pathname + window.location.search;
    window.location.assign(`${SIGN_IN_PATH}?expired=1&next=${encodeURIComponent(here)}`);
}

/**
 * The board's data: roster, strips, attention inputs and live updates.
 *
 * Live heartbeats are queued and applied in one render per ~250 ms. Strips
 * load on each live-hub snapshot and are patched locally by live beats. The
 * agent and backup reads happen once per snapshot (and on `backups` events),
 * never on a timer. Pausing buffers everything until resume (WCAG 2.2.2).
 */
function useBoardDataState(initialMonitors: MonitorSummary[] | null, renderedAt: number): BoardData {
    const [monitors, setMonitors] = useState<MonitorSummary[]>(initialMonitors ?? []);
    const [rosterLoaded, setRosterLoaded] = useState(initialMonitors !== null);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [strips, setStrips] = useState<Map<number, Strip>>(new Map());
    const [changedAt, setChangedAt] = useState<Map<number, number>>(new Map());
    const [warnings, setWarnings] = useState<Map<number, string>>(new Map());
    const [backups, setBackups] = useState<BackupAgentSummary[]>([]);
    const [cue, setCue] = useState<Cue>(NO_CUE);
    // The server's render time, so "checked 12s ago" hydrates to the same
    // text; the clock moves to the browser's own time right after.
    const [now, setNow] = useState(renderedAt);
    useEffect(() => setNow(Date.now()), []);
    const [paused, setPausedState] = useState(false);
    const [pending, setPending] = useState(0);

    const monitorsRef = useRef<MonitorSummary[]>(initialMonitors ?? []);
    const stripsRef = useRef<Map<number, Strip>>(new Map());
    const changedAtRef = useRef<Map<number, number>>(new Map());
    const batcherRef = useRef<EventBatcher<LiveBeat> | null>(null);
    const pausedRef = useRef(false);
    const heldRef = useRef<MonitorSummary[] | null>(null);
    const loadEpoch = useRef(0);
    const cueSeq = useRef(0);
    const stripLoading = useRef(false);
    const backlog = useRef<LiveBeat[]>([]);
    const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const left = useRef(false);
    const onUnauthorized = useCallback((error: ApiError) => {
        if (!left.current) {
            left.current = true;
            leave(error);
        }
    }, []);
    const secondaryAbort = useRef<AbortController | null>(null);

    const placeBeats = useCallback((beats: LiveBeat[], source: Map<number, Strip>, at: number): Map<number, Strip> => {
        if (source.size === 0) {
            return source;
        }
        const like = source.values().next().value as Strip;
        const next = new Map(source);
        for (const beat of beats) {
            const time = parseTime(beat.patch.lastCheck as string | null | undefined);
            const status = beat.patch.status;
            if (!Number.isFinite(time) || typeof status !== "number") {
                continue;
            }
            const strip = next.get(beat.monitorId) ?? blankStrip(like, at);
            next.set(beat.monitorId, placeBeat(strip, time, status, at));
        }
        return next;
    }, []);

    /** Secondary reads for a fresh roster: strips, agent warnings, backups. All quiet on failure. */
    const loadSecondary = useCallback(
        (roster: MonitorSummary[]) => {
            secondaryAbort.current?.abort();
            const controller = new AbortController();
            secondaryAbort.current = controller;
            const { signal } = controller;

            const members = roster.filter((m) => m.type !== "group");
            const loadStrips = async () => {
                if (members.length === 0) {
                    stripsRef.current = new Map();
                    setStrips(stripsRef.current);
                    return;
                }
                stripLoading.current = true;
                backlog.current = [];
                try {
                    const results = await Promise.allSettled(
                        chunkIds(members.map((m) => m.id)).map((ids) =>
                            fetchHeartbeatStrips(ids, { hours: STRIP_HOURS, buckets: STRIP_BUCKETS }, signal)
                        )
                    );
                    if (signal.aborted) {
                        return;
                    }
                    // Keep what we have for chunks that failed; an older backend without the endpoint gives none.
                    const merged = new Map<number, Strip>();
                    const ids = new Set(members.map((m) => m.id));
                    const chunks = chunkIds(members.map((m) => m.id));
                    results.forEach((result, index) => {
                        if (result.status === "fulfilled") {
                            for (const [id, strip] of stripsFromResponse(result.value)) {
                                merged.set(id, strip);
                            }
                        } else {
                            for (const id of chunks[index]) {
                                const old = stripsRef.current.get(id);
                                if (old) {
                                    merged.set(id, old);
                                }
                            }
                        }
                    });
                    for (const id of merged.keys()) {
                        if (!ids.has(id)) {
                            merged.delete(id);
                        }
                    }
                    stripsRef.current = placeBeats(backlog.current, merged, Date.now());
                    setStrips(stripsRef.current);
                } finally {
                    stripLoading.current = false;
                    backlog.current = [];
                }
            };

            const loadWarnings = async () => {
                const push = members.filter((m) => m.type === "push" && m.active);
                if (push.length === 0) {
                    setWarnings(new Map());
                    return;
                }
                try {
                    const found = new Map<number, string>();
                    const results = await Promise.all(
                        chunkIds(push.map((m) => m.id)).map((ids) => fetchLatestMetricsBulk(ids, signal))
                    );
                    for (const result of results) {
                        for (const [key, sample] of Object.entries(result.samples)) {
                            const monitor = push.find((m) => m.id === Number(key));
                            const warning = agentWarnings(sample?.metrics?.agent, monitor ?? {});
                            if (monitor && warning) {
                                found.set(monitor.id, warning.text);
                            }
                        }
                    }
                    if (!signal.aborted) {
                        setWarnings(found);
                    }
                } catch {
                    // Optional signal; the rest of the board is unaffected.
                }
            };

            void loadStrips().catch(() => undefined);
            void loadWarnings();
        },
        [placeBeats]
    );

    const loadBackups = useCallback(async () => {
        try {
            setBackups(await fetchAllBackupAgents());
        } catch {
            // Backups may be unavailable or not permitted; the attention list just omits them.
        }
    }, []);

    const applyRoster = useCallback(
        (next: MonitorSummary[]) => {
            batcherRef.current?.clear();
            monitorsRef.current = next;
            setMonitors(next);
            setRosterLoaded(true);
            setReady(true);
            setError(null);
            loadSecondary(next);
        },
        [loadSecondary]
    );

    const load = useCallback(
        async (strict: boolean, signal?: AbortSignal, force = false) => {
            const epoch = ++loadEpoch.current;
            try {
                const next = await fetchAllMonitors(signal);
                if (epoch !== loadEpoch.current) {
                    return;
                }
                if (pausedRef.current && !force) {
                    // Hold the snapshot; events from before it are superseded.
                    heldRef.current = next;
                    batcherRef.current?.clear();
                    setPending((n) => Math.max(1, n));
                    return;
                }
                heldRef.current = null;
                applyRoster(next);
            } catch (e) {
                if (epoch !== loadEpoch.current) {
                    return;
                }
                if (e instanceof ApiError && e.status === 401) {
                    onUnauthorized(e);
                    return;
                }
                setError(e instanceof Error ? e.message : "Failed to load.");
                if (strict) {
                    throw e;
                }
            }
        },
        [applyRoster, onUnauthorized]
    );

    const flush = useCallback(
        (items: LiveBeat[]) => {
            const previous = monitorsRef.current;
            const { patches, beats } = coalesceBeats(items);
            const next = applyPatches(previous, patches);
            const at = Date.now();

            if (stripLoading.current) {
                backlog.current.push(...beats);
            } else if (stripsRef.current.size) {
                stripsRef.current = placeBeats(beats, stripsRef.current, at);
                setStrips(stripsRef.current);
            }

            if (next !== previous) {
                const changed = changedStatusIds(previous, next);
                monitorsRef.current = next;
                setMonitors(next);
                setError(null);
                if (changed.length) {
                    const map = new Map(changedAtRef.current);
                    for (const id of changed) {
                        const last = [...beats].reverse().find((b) => b.monitorId === id);
                        const time = parseTime(last?.patch.lastCheck as string | undefined);
                        map.set(id, Number.isFinite(time) ? time : at);
                    }
                    changedAtRef.current = map;
                    setChangedAt(map);
                    const plan = planCues(changed);
                    const seq = ++cueSeq.current;
                    setCue({ seq, rows: new Set(plan.rows), group: plan.group, changed: changed.length });
                    window.setTimeout(() => {
                        setCue((current) =>
                            current.seq === seq ? { ...current, rows: new Set(), group: false } : current
                        );
                    }, HIGHLIGHT_MS + 200);
                }
            }
        },
        [placeBeats]
    );

    // Live stream.
    useEffect(() => {
        const batcher = new EventBatcher<LiveBeat>(LIVE_BATCH_MS, flush);
        batcherRef.current = batcher;
        if (pausedRef.current) {
            batcher.pause();
        }
        let backupTimer: ReturnType<typeof setTimeout> | null = null;

        const stop = subscribeLive({
            metrics: false,
            snapshot: (signal) => load(true, signal),
            ready: () => void loadBackups(),
            backups: () => {
                if (backupTimer) {
                    clearTimeout(backupTimer);
                }
                backupTimer = setTimeout(() => void loadBackups(), 1000);
            },
            event: (event) => {
                if (event.type !== "heartbeat") {
                    return;
                }
                batcher.push({ monitorId: event.monitorId, patch: event.patch });
                if (batcher.paused && pendingTimer.current === null) {
                    pendingTimer.current = setTimeout(() => {
                        pendingTimer.current = null;
                        setPending(batcher.size + (heldRef.current ? 1 : 0));
                    }, 500);
                }
            },
            error: (e) => {
                if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
                    onUnauthorized(e);
                    return;
                }
                setError("Live updates disconnected; reconnecting.");
            },
        });
        return () => {
            loadEpoch.current++;
            secondaryAbort.current?.abort();
            if (backupTimer) {
                clearTimeout(backupTimer);
            }
            batcher.dispose();
            batcherRef.current = null;
            stop();
        };
    }, [flush, load, loadBackups, onUnauthorized]);

    // Time moves on (strip window, "for 12m"); paused boards hold still.
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!pausedRef.current) {
                setNow(Date.now());
            }
        }, 30_000);
        return () => window.clearInterval(timer);
    }, []);

    const setPaused = useCallback(
        (value: boolean) => {
            pausedRef.current = value;
            setPausedState(value);
            const batcher = batcherRef.current;
            if (value) {
                batcher?.pause();
                return;
            }
            setPending(0);
            setNow(Date.now());
            if (heldRef.current) {
                const held = heldRef.current;
                heldRef.current = null;
                // The held snapshot supersedes older state; events queued after it apply next.
                const queued = batcher;
                monitorsRef.current = held;
                setMonitors(held);
                setRosterLoaded(true);
                loadSecondary(held);
                queued?.resume();
            } else {
                batcher?.resume();
            }
        },
        [loadSecondary]
    );

    const reload = useCallback(() => load(false, undefined, true), [load]);

    const alignedStrips = useMemo(() => {
        const out = new Map<number, Strip>();
        for (const [id, strip] of strips) {
            out.set(id, alignStrip(strip, now));
        }
        return out;
    }, [strips, now]);

    return {
        monitors,
        rosterLoaded,
        ready,
        error,
        setError,
        strips: alignedStrips,
        changedAt,
        agentWarnings: warnings,
        backups,
        cue,
        now,
        paused,
        setPaused,
        pending,
        reload,
    };
}

const BoardDataContext = createContext<BoardData | null>(null);

/**
 * One board data source for the whole admin area: the Monitors and
 * Attention pages, the sidebar count and the command palette read it, so the
 * roster, strips and the live stream load once per tab. Seeded with the
 * roster the layout read on the server (null when that read failed: the
 * first snapshot loads it).
 */
export function BoardDataProvider({
    initialMonitors,
    renderedAt,
    children,
}: {
    initialMonitors: MonitorSummary[] | null;
    /** `Date.now()` on the server when it rendered the roster. */
    renderedAt: number;
    children: React.ReactNode;
}) {
    const data = useBoardDataState(initialMonitors, renderedAt);
    return <BoardDataContext.Provider value={data}>{children}</BoardDataContext.Provider>;
}

export function useBoardData(): BoardData {
    const data = useContext(BoardDataContext);
    if (!data) {
        throw new Error("useBoardData() needs a BoardDataProvider above it");
    }
    return data;
}
