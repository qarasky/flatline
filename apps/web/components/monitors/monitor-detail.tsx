"use client";

import { ArrowLeft, Maximize2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api";
import { STATUS_LABEL } from "@/lib/board-format";
import { statusKeyOf } from "@/lib/board-model";
import { ageOf } from "@/lib/fleet-presentation";
import { prependBeat, type HeartbeatEntry } from "@/lib/heartbeat-log";
import { subscribeLive } from "@/lib/live-hub";
import type { MonitorSummary } from "@/lib/monitor-types";
import { BEAT_LIMIT, fetchHeartbeats, fetchMonitor, muteMonitor, unmuteMonitor } from "@/lib/monitors-api";
import { isCovered } from "@/lib/mute";
import { cn } from "@/lib/utils";

import { MonitorForm } from "./monitor-form";
import { StatusDot, statusTone } from "./status-dot";

export type DetailMonitor = MonitorSummary & Record<string, unknown>;

/** What the full page reads on the server, so it renders without a round trip. */
export interface DetailInitial {
    monitor: DetailMonitor;
    beats: HeartbeatEntry[];
    total: number;
}

const BEAT_TONE: Record<number, string> = {
    1: "bg-status-up",
    0: "bg-status-down",
    3: "bg-status-maint",
};

function beatLabel(status: number): string {
    return ({ 1: "Up", 0: "Down", 2: "Pending", 3: "Maintenance" } as Record<number, string>)[status] ?? "Unknown";
}

/** UTC minutes, the same on the server and in the browser. */
function formatTime(value: string): string {
    const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toISOString().slice(0, 16).replace("T", " ");
}

/** One bar per heartbeat, newest on the right; the events table carries the words. */
function BeatBar({ beats }: { beats: HeartbeatEntry[] }) {
    if (beats.length === 0) {
        return <p className="text-muted-foreground text-xs">No history yet.</p>;
    }
    const ordered = [...beats].reverse();
    return (
        <div className="flex flex-wrap items-end gap-[2px]" role="img" aria-label={`${beats.length} recent checks`}>
            {ordered.map((beat, i) => (
                <span
                    key={i}
                    title={`${formatTime(beat.time)} — ${beatLabel(beat.status)}${beat.ping != null ? ` ${Math.round(beat.ping)}ms` : ""}${beat.msg ? ` — ${beat.msg}` : ""}`}
                    className={cn("w-[3px] rounded-[2px]", BEAT_TONE[beat.status] ?? "bg-status-warn")}
                    style={{ height: beat.status === 0 ? 26 : 18 }}
                />
            ))}
        </div>
    );
}

/** Ping sparkline. Down beats are gaps, so an outage never looks like excellent latency. */
function PingSparkline({ beats }: { beats: HeartbeatEntry[] }) {
    const points = [...beats].reverse().filter((b) => b.status === 1 && b.ping != null);
    if (points.length < 2) {
        return <p className="text-muted-foreground text-xs">Not enough ping data yet.</p>;
    }
    const width = 100;
    const height = 32;
    const pings = points.map((b) => b.ping as number);
    const min = Math.min(...pings);
    const max = Math.max(...pings);
    const span = max - min || 1;
    const path = pings
        .map((ping, i) => {
            const x = (i / (pings.length - 1)) * width;
            const y = height - 3 - ((ping - min) / span) * (height - 6);
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    const last = pings[pings.length - 1];
    return (
        <div className="flex items-end gap-3">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                className="h-8 w-40"
                role="img"
                aria-label={`Ping trend, latest ${Math.round(last)}ms`}
                preserveAspectRatio="none"
            >
                <path
                    d={path}
                    fill="none"
                    stroke="var(--status-up)"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <div className="text-xs">
                <div className="text-sm font-semibold tabular-nums">{Math.round(last)}ms</div>
                <div className="text-muted-foreground">
                    <span className="tabular-nums">{Math.round(min)}</span>–
                    <span className="tabular-nums">{Math.round(max)}</span>ms range
                </div>
            </div>
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="bg-card rounded-md border p-3">
            <div className="text-muted-foreground mb-1 text-[11px] tracking-wide uppercase">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
        </div>
    );
}

const percent = (value: number | null | undefined) => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);

/**
 * One monitor: state, mute, uptime, recent checks, ping trend, certificate
 * and the event log. The same component is the peek panel (`compact`) and
 * the full page. Live beats are appended locally; the monitor and its last
 * 120 beats reload on each live snapshot.
 */
export function MonitorDetail({
    id,
    initial,
    compact = false,
    onClose,
    onDeleted,
    startEditing = false,
}: {
    id: number;
    initial?: DetailInitial;
    compact?: boolean;
    /** The peek's close button. */
    onClose?: () => void;
    /** The monitor is gone (deleted by someone else). */
    onDeleted?: () => void;
    /** Show the edit form straight away. */
    startEditing?: boolean;
}) {
    const { now, reload: reloadBoard } = useBoardData();
    const [editing, setEditing] = useState(startEditing);
    const reloadRef = useRef<() => Promise<void>>(async () => undefined);
    const [monitor, setMonitor] = useState<DetailMonitor | null>(initial?.monitor ?? null);
    // One state so a live beat updates the list and the total together.
    const [log, setLog] = useState<{ beats: HeartbeatEntry[]; total: number }>({
        beats: initial?.beats ?? [],
        total: initial?.total ?? 0,
    });
    const [error, setError] = useState<string | null>(null);
    const [deleted, setDeleted] = useState(false);
    const [muteError, setMuteError] = useState<string | null>(null);
    const [muting, setMuting] = useState(false);
    // Name of the monitor whose mute covers this one, when it is not this one.
    const [mutedWith, setMutedWith] = useState<string | null>(null);
    const onDeletedRef = useRef(onDeleted);
    onDeletedRef.current = onDeleted;

    const coveringSubject = monitor?.mutedBy?.find((subject) => subject !== monitor.id) ?? null;
    const ownMute = monitor?.mutedBy?.includes(monitor.id) ?? false;
    useEffect(() => {
        setMutedWith(null);
        if (coveringSubject === null || ownMute) {
            return;
        }
        const controller = new AbortController();
        fetchMonitor(coveringSubject, controller.signal)
            .then((m) => setMutedWith(m.monitor.name))
            .catch(() => setMutedWith(`#${coveringSubject}`));
        return () => controller.abort();
    }, [coveringSubject, ownMute]);

    useEffect(() => {
        let cancelled = false;
        setMuteError(null);
        setDeleted(false);
        if (initial?.monitor.id !== id) {
            setMonitor(null);
            setLog({ beats: [], total: 0 });
        }

        // Full reload on each live snapshot (connect, reconnect, invalidate);
        // single beats are appended below.
        async function load(signal?: AbortSignal) {
            try {
                const [m, h] = await Promise.all([fetchMonitor(id, signal), fetchHeartbeats(id, BEAT_LIMIT, signal)]);
                if (cancelled) {
                    return;
                }
                setMonitor(m.monitor);
                setLog({ beats: h.heartbeats, total: h.total });
                setError(null);
            } catch (e) {
                if (cancelled) {
                    return;
                }
                if (isApiError(e, 404)) {
                    setDeleted(true);
                    onDeletedRef.current?.();
                    return;
                }
                setError(e instanceof Error ? e.message : "Could not load the monitor.");
            }
        }

        reloadRef.current = () => load();
        const stop = subscribeLive({
            metrics: false,
            snapshot: load,
            event: (event) => {
                if (cancelled || event.type !== "heartbeat" || event.monitorId !== id) {
                    return;
                }
                setMonitor((previous) => (previous ? { ...previous, ...event.patch } : previous));
                setLog((previous) => {
                    const next = prependBeat(previous.beats, event.patch, BEAT_LIMIT);
                    return next.added ? { beats: next.beats, total: previous.total + 1 } : previous;
                });
            },
            error: () => {
                if (!cancelled) {
                    setError("Live updates disconnected; reconnecting.");
                }
            },
        });
        return () => {
            cancelled = true;
            stop();
        };
        // `initial` only seeds the first render of this id, so it is not a dependency.
    }, [id]);

    const back = compact ? (
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
        </Button>
    ) : (
        <Button variant="ghost" size="sm" asChild>
            <Link href="/monitors">
                <ArrowLeft />
                All monitors
            </Link>
        </Button>
    );

    if (deleted) {
        return (
            <div className="space-y-3 px-4 py-10">
                <p role="status">This monitor was deleted.</p>
                {compact ? (
                    <Button variant="outline" size="sm" onClick={onClose}>
                        Close
                    </Button>
                ) : (
                    <Button variant="outline" size="sm" asChild>
                        <Link href="/monitors">Back to Monitors</Link>
                    </Button>
                )}
            </div>
        );
    }
    if (!monitor) {
        return error ? (
            <div className="space-y-3 px-4 py-10">
                <p className="text-status-down">{error}</p>
                {back}
            </div>
        ) : (
            <p className="text-muted-foreground px-4 py-10">Loading…</p>
        );
    }

    const status = statusKeyOf(monitor);
    const covered = isCovered(monitor);

    // Mute a known outage, or clear every mute covering this monitor. The
    // live invalidate reloads the monitor with its new state.
    async function toggleMute(current: DetailMonitor) {
        setMuting(true);
        setMuteError(null);
        try {
            if (isCovered(current)) {
                await unmuteMonitor(current.id);
            } else {
                await muteMonitor(current.id);
            }
        } catch (e) {
            setMuteError(e instanceof Error ? e.message : "Mute failed.");
        } finally {
            setMuting(false);
        }
    }

    return (
        <div className="px-4 py-4">
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                {compact ? null : back}
                <h1 className="text-base font-semibold">{monitor.name}</h1>
                <span className={cn("flex items-center gap-1.5 text-xs font-medium", statusTone(status))}>
                    <StatusDot status={status} size={10} muted={covered} />
                    {covered && status === "down" ? `${STATUS_LABEL[status]} · muted` : STATUS_LABEL[status]}
                </span>
                <span className="text-muted-foreground text-xs">{monitor.type}</span>
                {covered ? (
                    <span className="text-status-muted text-xs">
                        {ownMute
                            ? monitor.mute?.mutedAt
                                ? `Muted ${ageOf(monitor.mute.mutedAt, now)} ago`
                                : "Muted"
                            : `Muted with ${mutedWith ?? "…"}`}
                    </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1.5">
                    {covered || monitor.status === 0 ? (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={muting}
                            onClick={() => void toggleMute(monitor)}
                            title={
                                covered
                                    ? "Alerts and the red colour come back"
                                    : "Acknowledge this outage: dark red, no repeat alerts until something new breaks"
                            }
                        >
                            {covered ? "Unmute" : "Mute"}
                        </Button>
                    ) : null}
                    {editing ? null : (
                        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                            Edit
                        </Button>
                    )}
                    {monitor.type === "push" ? (
                        <Button variant="ghost" size="sm" asChild>
                            <Link href={`/servers/${monitor.id}`}>Server page</Link>
                        </Button>
                    ) : null}
                    {compact ? (
                        <>
                            <Button variant="ghost" size="icon-sm" asChild>
                                <Link
                                    href={`/monitors/${monitor.id}`}
                                    aria-label="Open full page"
                                    title="Open full page"
                                >
                                    <Maximize2 />
                                </Link>
                            </Button>
                            {back}
                        </>
                    ) : null}
                </div>
            </div>
            {editing ? (
                <MonitorForm
                    key={monitor.id}
                    initial={monitor}
                    onCancel={() => setEditing(false)}
                    onSaved={() => {
                        setEditing(false);
                        void reloadRef.current();
                        void reloadBoard();
                    }}
                />
            ) : (
                <MonitorBody
                    monitor={monitor}
                    beats={log.beats}
                    total={log.total}
                    compact={compact}
                    error={error}
                    muteError={muteError}
                />
            )}
        </div>
    );
}

/** Everything under the header: numbers, recent checks, ping, certificate, events. */
function MonitorBody({
    monitor,
    beats,
    total,
    compact,
    error,
    muteError,
}: {
    monitor: DetailMonitor;
    beats: HeartbeatEntry[];
    total: number;
    compact: boolean;
    error: string | null;
    muteError: string | null;
}) {
    const downs = beats.filter((b) => b.status === 0).length;
    const certDays = monitor.certExpiryDaysRemaining;
    const hasCertDays = certDays !== "" && certDays != null;
    return (
        <>
            {muteError ? <p className="text-status-down mb-3 text-xs">{muteError}</p> : null}
            {error ? <p className="text-status-warn mb-3 text-xs">{error}</p> : null}
            {monitor.url ? <p className="text-muted-foreground mb-4 truncate text-xs">{monitor.url}</p> : null}

            <div className={cn("mb-4 grid grid-cols-2 gap-3", !compact && "md:grid-cols-4")}>
                <Stat label="24h uptime" value={percent(monitor.uptime24h)} />
                <Stat label="7d uptime" value={percent(monitor.uptime7d)} />
                <Stat label="30d uptime" value={percent(monitor.uptime30d)} />
                <Stat label="Interval" value={`${monitor.interval}s`} />
            </div>
            <div className={cn("mb-4 grid grid-cols-1 gap-3", !compact && "md:grid-cols-2")}>
                <div className="bg-card rounded-md border p-3">
                    <div className="text-muted-foreground mb-2 text-[11px] tracking-wide uppercase">
                        Recent checks{" "}
                        <span className="tabular-nums">
                            ({beats.length} of {total})
                        </span>
                    </div>
                    <BeatBar beats={beats} />
                </div>
                <div className="bg-card rounded-md border p-3">
                    <div className="text-muted-foreground mb-2 text-[11px] tracking-wide uppercase">Ping trend</div>
                    <PingSparkline beats={beats} />
                </div>
            </div>
            {monitor.validCert || hasCertDays ? (
                <div className="bg-card mb-4 rounded-md border p-3 text-xs">
                    <span className="text-muted-foreground mr-3">Certificate</span>
                    {monitor.validCert ? (
                        <span className="text-status-up">valid</span>
                    ) : (
                        <span className="text-status-down">invalid</span>
                    )}
                    {hasCertDays ? (
                        <span className="text-muted-foreground ml-3 tabular-nums">
                            expires in {String(certDays)} days
                        </span>
                    ) : null}
                </div>
            ) : null}

            <h2 className="text-muted-foreground mb-2 text-[11px] tracking-wide uppercase">
                Events {downs > 0 ? <span className="tabular-nums">({downs} outages in view)</span> : null}
            </h2>
            {beats.length === 0 ? (
                <p className="text-muted-foreground">No checks recorded yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
                                <th className="py-2 pr-4 font-medium">Time</th>
                                <th className="w-32 py-2 font-medium">Status</th>
                                <th className="w-20 py-2 pl-3 text-right font-medium">Ping</th>
                                <th className="py-2 pl-3 font-medium">Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            {beats.map((beat, i) => {
                                const key = statusKeyOf({ active: true, status: beat.status });
                                return (
                                    <tr key={i} className="border-border/60 border-b last:border-0">
                                        <td className="text-muted-foreground py-1.5 pr-4 whitespace-nowrap tabular-nums">
                                            {formatTime(beat.time)}
                                        </td>
                                        <td className="py-1.5 whitespace-nowrap">
                                            <span className={cn("flex items-center gap-1.5 text-xs", statusTone(key))}>
                                                <StatusDot status={key} size={9} />
                                                {beatLabel(beat.status)}
                                            </span>
                                        </td>
                                        <td className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                                            {beat.ping == null ? "—" : `${Math.round(beat.ping)}ms`}
                                        </td>
                                        <td className="text-muted-foreground max-w-md truncate py-1.5 pl-3 text-xs">
                                            {beat.msg || "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
