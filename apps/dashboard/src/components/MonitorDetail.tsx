import { useEffect, useRef, useState } from "react";
import {
    backupDownloadUrl,
    fetchBackupAgents,
    fetchBackupRuns,
    fetchHeartbeats,
    fetchMonitor,
    muteMonitor,
    unmuteMonitor,
    type BackupAgentSummary,
    type BackupRunSummary,
    type MonitorSummary,
} from "@/lib/api";
import { backupFileName } from "@/lib/backup-presentation";
import { prependBeat, type HeartbeatEntry } from "@/lib/heartbeat-log";
import { subscribeLive } from "@/lib/live-hub";
import { ageOf } from "@/lib/fleet-presentation";
import { isCovered } from "@/lib/mute";
import { BackupAgents } from "@/components/BackupAgents";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type { HeartbeatEntry };

/** Rows kept in the recent-checks list. */
const BEAT_LIMIT = 120;

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

function formatTime(value: string): string {
    const date = new Date(value.replace(" ", "T") + (value.includes("Z") ? "" : "Z"));
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Beat bar: one div per heartbeat, newest on the right.
 *
 * Divs rather than a canvas so it works without JS-driven drawing and stays
 * legible when zoomed. Colour is never the only signal; the event table below
 * carries the words.
 */
function BeatBar({ beats }: { beats: HeartbeatEntry[] }) {
    if (beats.length === 0) {
        return <p className="text-xs text-quiet">No history yet.</p>;
    }

    // Oldest first so the newest beat sits on the right, matching the trend.
    const ordered = [...beats].reverse();

    return (
        <div className="flex flex-wrap items-end gap-[2px]" role="img" aria-label={`${beats.length} recent checks`}>
            {ordered.map((beat, i) => (
                <span
                    key={i}
                    title={`${formatTime(beat.time)} — ${statusOf(beat.status).label}${beat.ping != null ? ` ${Math.round(beat.ping)}ms` : ""}${beat.msg ? ` — ${beat.msg}` : ""}`}
                    className={`w-[3px] rounded-[2px] ${
                        beat.status === 1
                            ? "bg-ok"
                            : beat.status === 0
                              ? "bg-bad"
                              : beat.status === 3
                                ? "bg-maint"
                                : "bg-warn"
                    }`}
                    style={{ height: beat.status === 0 ? 26 : 18 }}
                />
            ))}
        </div>
    );
}

/**
 * Ping sparkline, hand-rolled SVG.
 *
 * Deliberately not a chart library: 40 points of ping history need a line, not
 * Chart.js. Down beats render as gaps rather than zero, so an outage never
 * looks like excellent latency.
 */
function PingSparkline({ beats }: { beats: HeartbeatEntry[] }) {
    const points = [...beats].reverse().filter((b) => b.status === 1 && b.ping != null);

    if (points.length < 2) {
        return <p className="text-xs text-quiet">Not enough ping data yet.</p>;
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
            // Invert: high ping goes low on screen.
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
                    stroke="var(--color-ok)"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <div className="text-xs">
                <div className="tnum text-sm font-semibold">{Math.round(last)}ms</div>
                <div className="text-quiet">
                    <span className="tnum">{Math.round(min)}</span>–<span className="tnum">{Math.round(max)}</span>ms
                    range
                </div>
            </div>
        </div>
    );
}

/**
 * Monitor detail view.
 *
 * Dense like the table, not airy like the status site: header with current
 * state, beat bar, ping trend, key numbers, then the event log. Everything on
 * one screen with no tabs.
 */
export function MonitorDetail({
    id,
    onBack,
    onEdit,
    compact = false,
}: {
    id: number;
    onBack: () => void;
    /** Rendered in the board's side pane / sheet: closer wording, narrower grids. */
    compact?: boolean;
    onEdit: (monitor: MonitorSummary & Record<string, unknown>) => void;
}) {
    const [monitor, setMonitor] = useState<(MonitorSummary & Record<string, unknown>) | null>(null);
    // One state so a live beat updates the list and the total together.
    const [log, setLog] = useState<{ beats: HeartbeatEntry[]; total: number }>({ beats: [], total: 0 });
    const { beats, total } = log;
    const [error, setError] = useState<string | null>(null);
    const [backups, setBackups] = useState<BackupAgentSummary[]>([]);
    const [backupRuns, setBackupRuns] = useState<Record<string, BackupRunSummary[]>>({});
    const [backupError, setBackupError] = useState<string | null>(null);
    const [muteError, setMuteError] = useState<string | null>(null);
    const [muting, setMuting] = useState(false);
    // Name of the monitor whose mute covers this one, when it is not this one.
    const [mutedWith, setMutedWith] = useState<string | null>(null);
    const currentMonitor = useRef(id);
    currentMonitor.current = id;
    const loadGeneration = useRef(0);

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
        setMuteError(null);
    }, [id]);

    useEffect(() => {
        let cancelled = false;
        // A monitor switch must not show the previous monitor's backup rows
        // while the new snapshot is still loading.
        setBackups([]);
        setBackupRuns({});
        setBackupError(null);

        // Full reload only on (re)connect and invalidate: the shared stream's
        // snapshot. Individual beats are appended locally below.
        async function load(signal?: AbortSignal) {
            const generation = ++loadGeneration.current;
            const stale = () => cancelled || currentMonitor.current !== id || loadGeneration.current !== generation;
            try {
                const [m, h] = await Promise.all([fetchMonitor(id, signal), fetchHeartbeats(id, BEAT_LIMIT, signal)]);
                if (stale()) {
                    return;
                }
                setMonitor(m.monitor);
                setLog({ beats: h.heartbeats, total: h.total });
                setError(null);
            } catch (e) {
                if (!stale()) {
                    setError(e instanceof Error ? e.message : "Could not load monitor.");
                }
            }
        }

        // Backup rows cost 1 + N requests, so they load on mount, on a
        // backup-specific event and after a reconnect only, never on
        // heartbeats or generic invalidations. One load runs at a time; an
        // event during a load schedules exactly one follow-up.
        let backupController: AbortController | null = null;
        let backupLoading = false;
        let backupDirty = false;
        async function loadBackups() {
            if (cancelled) {
                return;
            }
            if (backupLoading) {
                backupDirty = true;
                return;
            }
            backupLoading = true;
            backupController = new AbortController();
            const signal = backupController.signal;
            const stale = () => cancelled || currentMonitor.current !== id || signal.aborted;
            // Backup health is a separate read: a failure here must keep the
            // monitor details visible and report only the backup problem.
            try {
                const result = await fetchBackupAgents(id, signal);
                // Bounded history: the receiver returns newest-first and the
                // UI keeps at most five rows per agent.
                const histories = await Promise.all(
                    result.agents.map((agent) =>
                        fetchBackupRuns(agent.id, signal)
                            .then((runs) => runs.runs.slice(0, 5))
                            .catch(() => [])
                    )
                );
                if (!stale()) {
                    setBackups(result.agents);
                    setBackupRuns(
                        Object.fromEntries(result.agents.map((agent, index) => [agent.id, histories[index]]))
                    );
                    setBackupError(null);
                }
            } catch (e) {
                if (!stale()) {
                    setBackupError(e instanceof Error ? `Backups unavailable: ${e.message}` : "Backups unavailable.");
                }
            } finally {
                backupLoading = false;
                if (backupDirty && !cancelled) {
                    backupDirty = false;
                    void loadBackups();
                }
            }
        }

        void loadBackups();
        let connectedOnce = false;
        const stop = subscribeLive({
            metrics: false,
            snapshot: load,
            ready: () => {
                // The first connect follows the mount load; later ones may
                // have missed backup events while disconnected.
                if (connectedOnce) {
                    void loadBackups();
                }
                connectedOnce = true;
            },
            backups: () => void loadBackups(),
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
            backupController?.abort();
            stop();
        };
    }, [id]);

    if (error && !monitor) {
        return (
            <div className="px-4 py-10">
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onBack}>
                    Back
                </Button>
            </div>
        );
    }

    if (!monitor) {
        return <p className="px-4 py-10 text-sm text-quiet">Loading…</p>;
    }

    async function handleDownload(run: BackupRunSummary) {
        try {
            // A single-use ticket URL: the browser streams the bundle to disk
            // itself instead of holding up to 8 GiB in memory.
            const url = await backupDownloadUrl(run.id);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = backupFileName(run);
            anchor.rel = "noreferrer";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } catch (e) {
            setBackupError(e instanceof Error ? `Download failed: ${e.message}` : "Download failed.");
        }
    }

    const status = statusOf(monitor.status);
    const downs = beats.filter((b) => b.status === 0);
    const covered = isCovered(monitor);

    // Mute a known outage, or clear every mute covering this monitor. The
    // live invalidate reloads the monitor with its new state.
    async function toggleMute(current: MonitorSummary) {
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
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <Button variant="ghost" size="sm" onClick={onBack}>
                    {compact ? "✕ Close" : "← All monitors"}
                </Button>
                <h1 className="text-base font-semibold">{monitor.name}</h1>
                <Badge tone={status.tone}>
                    <span className="size-1.5 rounded-full bg-current" />
                    {status.label}
                </Badge>
                {!monitor.active ? <span className="text-xs text-quiet">paused</span> : null}
                <span className="text-xs text-quiet">{monitor.type}</span>
                {covered ? (
                    <span className="text-xs text-bad-dim">
                        {ownMute
                            ? monitor.mute?.mutedAt
                                ? `Muted ${ageOf(monitor.mute.mutedAt)} ago`
                                : "Muted"
                            : `Muted with ${mutedWith ?? "…"}`}
                    </span>
                ) : null}

                <div className="ml-auto flex items-center gap-2">
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
                    <Button variant="outline" size="sm" onClick={() => onEdit(monitor)}>
                        Edit
                    </Button>
                </div>
            </div>
            {muteError ? <p className="mb-3 text-xs text-destructive">{muteError}</p> : null}

            {monitor.url ? <p className="mb-4 truncate text-xs text-quiet">{monitor.url}</p> : null}

            <div className={`mb-4 grid grid-cols-2 gap-3 ${compact ? "" : "md:grid-cols-4"}`}>
                <div className="rounded-md border border-border bg-card p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-quiet">24h uptime</div>
                    <div className="tnum text-lg font-semibold">
                        {monitor.uptime24h == null ? "—" : `${(monitor.uptime24h * 100).toFixed(1)}%`}
                    </div>
                </div>
                <div className="rounded-md border border-border bg-card p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-quiet">7d uptime</div>
                    <div className="tnum text-lg font-semibold">
                        {monitor.uptime7d == null ? "—" : `${(monitor.uptime7d * 100).toFixed(1)}%`}
                    </div>
                </div>
                <div className="rounded-md border border-border bg-card p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-quiet">30d uptime</div>
                    <div className="tnum text-lg font-semibold">
                        {monitor.uptime30d == null ? "—" : `${(monitor.uptime30d * 100).toFixed(1)}%`}
                    </div>
                </div>
                <div className="rounded-md border border-border bg-card p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-quiet">Interval</div>
                    <div className="tnum text-lg font-semibold">{monitor.interval}s</div>
                </div>
            </div>

            <div className={`mb-4 grid grid-cols-1 gap-3 ${compact ? "" : "md:grid-cols-2"}`}>
                <div className="rounded-md border border-border bg-card p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-quiet">
                        Recent checks{" "}
                        <span className="tnum">
                            ({beats.length} of {total})
                        </span>
                    </div>
                    <BeatBar beats={beats} />
                </div>
                <div className="rounded-md border border-border bg-card p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-quiet">Ping trend</div>
                    <PingSparkline beats={beats} />
                </div>
            </div>

            {monitor.validCert ||
            (monitor.certExpiryDaysRemaining !== "" && monitor.certExpiryDaysRemaining != null) ? (
                <div className="mb-4 rounded-md border border-border bg-card p-3 text-xs">
                    <span className="mr-3 text-quiet">Certificate</span>
                    {monitor.validCert ? (
                        <span className="text-ok">valid</span>
                    ) : (
                        <span className="text-bad">invalid</span>
                    )}
                    {monitor.certExpiryDaysRemaining !== "" && monitor.certExpiryDaysRemaining != null ? (
                        <span className="tnum ml-3 text-quiet">
                            expires in {String(monitor.certExpiryDaysRemaining)} days
                        </span>
                    ) : null}
                </div>
            ) : null}

            <BackupAgents agents={backups} runs={backupRuns} error={backupError} onDownload={handleDownload} />

            <h2 className="mb-2 text-[11px] uppercase tracking-wide text-quiet">
                Events {downs.length > 0 ? <span className="tnum">({downs.length} outages in view)</span> : null}
            </h2>

            {beats.length === 0 ? (
                <p className="text-sm text-quiet">No checks recorded yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="py-2 pr-4 font-medium">Time</th>
                                <th className="w-32 py-2 font-medium">Status</th>
                                <th className="w-20 py-2 pl-3 text-right font-medium">Ping</th>
                                <th className="py-2 pl-3 font-medium">Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            {beats.map((beat, i) => {
                                const s = statusOf(beat.status);
                                return (
                                    <tr key={i} className="border-b border-border/60 last:border-0">
                                        <td className="tnum py-1.5 pr-4 whitespace-nowrap text-quiet">
                                            {formatTime(beat.time)}
                                        </td>
                                        <td className="py-1.5 whitespace-nowrap">
                                            <Badge tone={s.tone}>
                                                <span className="size-1.5 rounded-full bg-current" />
                                                {s.label}
                                            </Badge>
                                        </td>
                                        <td className="tnum py-1.5 pl-3 text-right whitespace-nowrap">
                                            {beat.ping == null ? "—" : `${Math.round(beat.ping)}ms`}
                                        </td>
                                        <td className="max-w-md truncate py-1.5 pl-3 text-xs text-quiet">
                                            {beat.msg || "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
