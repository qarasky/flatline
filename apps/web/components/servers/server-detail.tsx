"use client";

import { Activity, Pencil } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { BackupAgents } from "@/components/fleet/backup-agents";
import { ContainerRows } from "@/components/fleet/container-rows";
import { CoreSquares } from "@/components/fleet/core-squares";
import { LoadHistory } from "@/components/fleet/load-history";
import { UsageBar } from "@/components/fleet/metric-bar";
import { ProviderLogo } from "@/components/fleet/provider-logo";
import { LinkPicker } from "@/components/monitors/link-picker";
import { MonitorForm, type FormInitial } from "@/components/monitors/monitor-form";
import { StatusDot, statusTone } from "@/components/monitors/status-dot";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { backupFileName } from "@/lib/backup-presentation";
import { STATUS_LABEL } from "@/lib/board-format";
import { statusKeyOf } from "@/lib/board-model";
import { downloadBackupRun, fetchBackupAgents, fetchBackupRuns } from "@/lib/backups-api";
import {
    ageOf,
    agentWarnings,
    formatBytesPair,
    isSampleStale,
    percentage,
    smartWarning,
    updatesStatus,
} from "@/lib/fleet-presentation";
import { buildLinkCandidates, linkStatusLabel, linkTone, sortLinks } from "@/lib/links";
import type { BackupAgentSummary, BackupRunSummary, MonitorLinks, MonitorSummary } from "@/lib/monitor-types";
import {
    clearAgentWarnings,
    fetchMonitor,
    fetchMonitorLinks,
    muteMonitor,
    replaceMonitorLinks,
    unmuteMonitor,
} from "@/lib/monitors-api";
import { isCovered } from "@/lib/mute";
import type { ServerSample } from "@/lib/server-row";
import { cn } from "@/lib/utils";

import { useFleetMetrics } from "./use-fleet-metrics";

const TONE_TEXT: Record<string, string> = {
    up: "text-ok",
    bad: "text-bad",
    pending: "text-warn",
    maintenance: "text-maint",
    neutral: "text-quiet",
    ok: "text-ok",
    warn: "text-warn",
    quiet: "text-quiet",
    critical: "text-bad",
    reboot: "text-warn",
};

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <section className="border-b px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
                <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">{title}</h2>
                {action ? <div className="ml-auto">{action}</div> : null}
            </div>
            {children}
        </section>
    );
}

function Meter({ label, percent, detail }: { label: string; percent: number | undefined; detail?: string | null }) {
    return (
        <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground truncate">{label}</span>
                <span className="tnum">
                    {percentage(percent)}
                    {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
                </span>
            </div>
            <div className="mt-1">
                <UsageBar percent={percent} label={label} />
            </div>
        </div>
    );
}

/** Live numbers from the latest sample: CPU with its cores, memory, every disk, GPUs. */
function LiveMetrics({ sample, interval, now }: { sample: ServerSample | undefined; interval: number; now: number }) {
    if (!sample) {
        return (
            <p className="text-muted-foreground">No metrics yet. They appear once the agent pushes its first sample.</p>
        );
    }
    const { metrics, time } = sample;
    const stale = isSampleStale(metrics, time, interval, now);
    const gpus = metrics.gpu?.gpus?.length ? metrics.gpu.gpus : metrics.gpu?.available ? [metrics.gpu] : [];
    return (
        <div className="grid gap-4">
            <p className={cn("text-xs", stale ? "text-warn" : "text-muted-foreground")}>
                {stale ? `Stale: last sample ${ageOf(time, now)} ago` : `Updated ${ageOf(time, now)} ago`}
                {metrics.host?.hostname ? ` · ${metrics.host.hostname}` : ""}
                {metrics.load?.avg1 !== undefined ? ` · load ${metrics.load.avg1.toFixed(2)}` : ""}
            </p>
            <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                    <Meter
                        label={`CPU${metrics.cpu?.cores ? ` · ${metrics.cpu.cores} cores` : ""}`}
                        percent={metrics.cpu?.percent}
                        detail={metrics.cpu?.temp ? `${Math.round(metrics.cpu.temp)}°C` : null}
                    />
                    <CoreSquares values={metrics.cpu?.perCore} label="Core" />
                    {sample.cpuPeak10m ? (
                        <p className="text-muted-foreground text-xs tnum">
                            Peak in the last 10 minutes: {percentage(sample.cpuPeak10m.percent)}
                        </p>
                    ) : null}
                </div>
                <div className="grid content-start gap-3">
                    <Meter
                        label="Memory"
                        percent={metrics.mem?.percent}
                        detail={formatBytesPair(metrics.mem?.used, metrics.mem?.total)}
                    />
                    {(metrics.disk ?? []).map((disk) => (
                        <Meter
                            key={disk.mount}
                            label={`Disk ${disk.mount ?? ""}`}
                            percent={disk.percent}
                            detail={formatBytesPair(disk.used, disk.total)}
                        />
                    ))}
                    {gpus.map((gpu, i) => (
                        <Meter
                            key={`gpu-${i}`}
                            label={`GPU ${gpu.name ?? i}`}
                            percent={gpu.util}
                            detail={formatBytesPair(gpu.memUsed, gpu.memTotal)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

/** The agent's own report: version, pending updates, disk health and its warning counters. */
function AgentReport({
    monitor,
    sample,
    onCleared,
}: {
    monitor: MonitorSummary;
    sample: ServerSample | undefined;
    onCleared: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const metrics = sample?.metrics;
    const warning = agentWarnings(metrics?.agent, monitor);
    const updates = updatesStatus(metrics?.updates);
    const smart = smartWarning(metrics?.smart);
    async function clear() {
        setBusy(true);
        setError(null);
        try {
            await clearAgentWarnings(monitor.id);
            onCleared();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not clear the warnings.");
        } finally {
            setBusy(false);
        }
    }
    return (
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="tnum">{metrics?.agent?.version ?? "—"}</dd>
            <dt className="text-muted-foreground">Updates</dt>
            <dd className={updates ? TONE_TEXT[updates.tone] : "text-quiet"} title={updates?.title}>
                {updates?.label ?? "Unknown"}
            </dd>
            {smart ? (
                <>
                    <dt className="text-muted-foreground">Disk health</dt>
                    <dd className={TONE_TEXT[smart.tone]} title={smart.title}>
                        {smart.text}
                    </dd>
                </>
            ) : null}
            <dt className="text-muted-foreground">Warnings</dt>
            <dd>
                {warning ? (
                    <span className="flex flex-wrap items-center gap-2">
                        <span className="text-warn" title={warning.title} data-agent-warning>
                            {warning.text}
                        </span>
                        <Button variant="outline" size="xs" disabled={busy} onClick={() => void clear()}>
                            Clear warnings
                        </Button>
                    </span>
                ) : (
                    <span className="text-quiet">None</span>
                )}
                {error ? <span className="text-bad block text-xs">{error}</span> : null}
            </dd>
        </dl>
    );
}

/** The websites this server hosts, with their status, and the picker to change them. */
function LinkedWebsites({ monitor, monitors }: { monitor: MonitorSummary; monitors: MonitorSummary[] }) {
    const [links, setLinks] = useState<MonitorLinks | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [selection, setSelection] = useState<Set<number>>(new Set());
    const [saving, setSaving] = useState(false);
    const candidates = useMemo(() => buildLinkCandidates(monitors, monitor.id), [monitors, monitor.id]);

    const load = useCallback(async () => {
        try {
            const answer = await fetchMonitorLinks(monitor.id);
            setLinks(answer);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load the linked websites.");
        }
    }, [monitor.id]);
    useEffect(() => {
        void load();
    }, [load]);

    async function save() {
        setSaving(true);
        try {
            setLinks(await replaceMonitorLinks(monitor.id, [...selection]));
            setEditing(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save the linked websites.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Section
            title="Linked websites"
            action={
                <Button
                    variant="outline"
                    size="xs"
                    disabled={links === null}
                    onClick={() => {
                        setSelection(new Set(links?.raw.map((l) => l.linkedMonitorId) ?? []));
                        setEditing(true);
                    }}
                >
                    <Pencil />
                    Edit links
                </Button>
            }
        >
            {error ? <p className="text-bad text-xs">{error}</p> : null}
            {links === null ? null : links.resolved.length === 0 ? (
                <p className="text-muted-foreground">
                    No websites linked. Their status would show here and on the Superboard card.
                </p>
            ) : (
                <ul className="grid gap-1" aria-label="Linked websites">
                    {sortLinks(links.resolved).map((link) => (
                        <li key={link.id} className="flex items-center gap-2">
                            <StatusDot status={statusKeyOf({ active: true, status: link.status })} size={10} />
                            <Link href={`/monitors/${link.id}`} className="min-w-0 truncate hover:underline">
                                {link.name}
                            </Link>
                            <span className={cn("text-xs", TONE_TEXT[linkTone(link.status)])}>
                                {linkStatusLabel(link.status)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <Dialog open={editing} onOpenChange={setEditing}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Linked websites</DialogTitle>
                        <DialogDescription>
                            The websites {monitor.name} hosts. A group includes every website inside it.
                        </DialogDescription>
                    </DialogHeader>
                    <LinkPicker
                        candidates={candidates}
                        selected={selection}
                        disabled={saving}
                        onToggle={(id) =>
                            setSelection((prev) => {
                                const next = new Set(prev);
                                if (next.has(id)) {
                                    next.delete(id);
                                } else {
                                    next.add(id);
                                }
                                return next;
                            })
                        }
                    />
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={() => void save()} disabled={saving}>
                            {saving ? "Saving…" : "Save links"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Section>
    );
}

/** The backup agents linked to this server, their last runs, and downloads. */
function ServerBackups({ monitorId }: { monitorId: number }) {
    const [agents, setAgents] = useState<BackupAgentSummary[]>([]);
    const [runs, setRuns] = useState<Record<string, BackupRunSummary[]>>({});
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        (async () => {
            try {
                const list = await fetchBackupAgents(monitorId, controller.signal);
                const histories = await Promise.all(
                    list.agents.map((agent) =>
                        fetchBackupRuns(agent.id, controller.signal)
                            .then((r) => r.runs.slice(0, 5))
                            .catch(() => [])
                    )
                );
                setAgents(list.agents);
                setRuns(Object.fromEntries(list.agents.map((agent, i) => [agent.id, histories[i]])));
            } catch (e) {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? `Backups unavailable: ${e.message}` : "Backups unavailable.");
                }
            }
        })();
        return () => controller.abort();
    }, [monitorId]);
    if (agents.length === 0 && !error) {
        return null;
    }
    return (
        <Section title="Backups">
            <BackupAgents
                agents={agents}
                runs={runs}
                error={error}
                onDownload={(run) =>
                    void downloadBackupRun(run.id, backupFileName(run)).catch((e) =>
                        setError(e instanceof Error ? `Download failed: ${e.message}` : "Download failed.")
                    )
                }
            />
            <p className="mt-2 text-xs">
                {agents.map((agent) => (
                    <Link
                        key={agent.id}
                        href={`/backups/${agent.id}`}
                        className="text-muted-foreground mr-3 hover:underline"
                    >
                        Manage {agent.name} →
                    </Link>
                ))}
            </p>
        </Section>
    );
}

/**
 * One server: live numbers, the agent's report, load history, containers,
 * linked websites, thresholds and backups. Edit opens the monitor form in place.
 */
export function ServerDetail({
    initial,
    initialSample,
}: {
    initial: MonitorSummary;
    initialSample: ServerSample | null;
}) {
    const { monitors, now, reload } = useBoardData();
    const monitor = monitors.find((m) => m.id === initial.id) ?? initial;
    const live = useFleetMetrics(useMemo(() => [initial.id], [initial.id]));
    const sample = live.get(initial.id) ?? initialSample ?? undefined;
    // The full record (with its notification links) the form edits; null when closed.
    const [editing, setEditing] = useState<FormInitial | null>(null);
    const [muteError, setMuteError] = useState<string | null>(null);
    const status = statusKeyOf(monitor);
    const covered = isCovered(monitor);

    async function toggleMute() {
        setMuteError(null);
        try {
            await (covered ? unmuteMonitor(monitor.id) : muteMonitor(monitor.id));
            await reload();
        } catch (e) {
            setMuteError(e instanceof Error ? e.message : "Mute failed.");
        }
    }

    return (
        <div className="flex flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
                <ProviderLogo provider={monitor.provider} />
                <h1 className="text-base font-semibold">{monitor.name}</h1>
                <span className={cn("flex items-center gap-1.5 text-xs font-medium", statusTone(status))}>
                    <StatusDot status={status} size={10} muted={covered} />
                    {covered && status === "down" ? "Down · muted" : STATUS_LABEL[status]}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                    {covered || monitor.status === 0 ? (
                        <Button variant="outline" size="sm" onClick={() => void toggleMute()}>
                            {covered ? "Unmute" : "Mute"}
                        </Button>
                    ) : null}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            if (editing) {
                                setEditing(null);
                                return;
                            }
                            fetchMonitor(monitor.id)
                                .then((answer) => setEditing(answer.monitor))
                                .catch((e) =>
                                    setMuteError(e instanceof Error ? e.message : "Could not open the editor.")
                                );
                        }}
                    >
                        {editing ? "Close editor" : "Edit"}
                    </Button>
                    <Button variant="ghost" size="sm" asChild>
                        <Link href={`/monitors/${monitor.id}`}>
                            <Activity />
                            Checks
                        </Link>
                    </Button>
                </div>
                {muteError ? <p className="text-bad w-full text-xs">{muteError}</p> : null}
            </div>
            {editing ? (
                <div className="border-b px-4 py-4">
                    <MonitorForm
                        initial={editing}
                        onCancel={() => setEditing(null)}
                        onSaved={() => {
                            setEditing(null);
                            void reload();
                        }}
                    />
                </div>
            ) : null}
            <Section title="Now">
                <LiveMetrics sample={sample} interval={monitor.interval} now={now} />
            </Section>
            <Section title="Agent">
                <AgentReport monitor={monitor} sample={sample} onCleared={() => void reload()} />
            </Section>
            <Section title="Load history">
                <LoadHistory monitorId={monitor.id} />
            </Section>
            {sample?.metrics.docker?.length ? (
                <Section title={`Containers · ${sample.metrics.docker.length}`}>
                    <ContainerRows containers={sample.metrics.docker} />
                </Section>
            ) : null}
            <LinkedWebsites monitor={monitor} monitors={monitors} />
            <Section title="Alert thresholds">
                <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm tnum">
                    <dt className="text-muted-foreground">CPU</dt>
                    <dd>{monitor.metricCpuThreshold != null ? `${monitor.metricCpuThreshold}%` : "Off"}</dd>
                    <dt className="text-muted-foreground">RAM</dt>
                    <dd>{monitor.metricRamThreshold != null ? `${monitor.metricRamThreshold}%` : "Off"}</dd>
                    <dt className="text-muted-foreground">Disk</dt>
                    <dd>{monitor.metricDiskThreshold != null ? `${monitor.metricDiskThreshold}%` : "Off"}</dd>
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd>{monitor.provider ?? "—"}</dd>
                </dl>
            </Section>
            <ServerBackups monitorId={monitor.id} />
        </div>
    );
}
