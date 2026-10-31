"use client";

import { memo, useEffect, useState, type MouseEvent } from "react";
import type {
    BackupAgentSummary,
    CPUPeak,
    MetricsPayload,
    MonitorSummary,
    ResolvedMonitorLink,
} from "@/lib/monitor-types";
import { backupAttention, backupLines, backupVersion } from "@/lib/backup-card";
import {
    ageOf,
    agentWarnings,
    containerAgeMs,
    containerRows,
    fleetAttention,
    formatBytes,
    formatBytesPair,
    formatDuration,
    percentage,
    smartWarning,
    updatesStatus,
} from "@/lib/fleet-presentation";
import { linkStatusLabel, linkTone, sortLinks } from "@/lib/links";
import { cardMute } from "@/lib/mute";
import { ContainerRows } from "@/components/fleet/container-rows";
import { CoreSquares } from "@/components/fleet/core-squares";
import { MetricBar, UsageBar } from "@/components/fleet/metric-bar";
import { ProviderLogo } from "@/components/fleet/provider-logo";
import { LinkStatusDot } from "./website-links";

export interface FleetServer {
    monitor: MonitorSummary;
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
    /** Linked websites hosted on this server, resolved worst-first on render. */
    links?: ResolvedMonitorLink[];
}

/**
 * "12s ago", ticking on its own once a second.
 *
 * Isolated so the per-second tick re-renders one text node per card instead
 * of the whole card (which would defeat FleetCard's memo).
 */
function SampleAge({ time }: { time: string }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                setNow(Date.now());
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);
    return <>{ageOf(time, now)} ago</>;
}

/** "muted 2d ago" under the status badge. Ticks on its own like SampleAge. */
function MutedAge({ since }: { since: string | null }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                setNow(Date.now());
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);
    return <span className="fleet-muted tnum">{since ? `muted ${ageOf(since, now)} ago` : "muted"}</span>;
}

/**
 * One "last backup … ago" line per backup agent, under "Updated". Ticks on
 * its own like SampleAge, so the card's memo holds.
 */
function BackupLines({ agents }: { agents: BackupAgentSummary[] }) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                setNow(Date.now());
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);
    return (
        <>
            {backupLines(agents, now).map((line) => (
                <span
                    key={line.key}
                    className={`fleet-freshness tnum ${line.tone === "warn" ? "text-warn" : "text-quiet"}`}
                    title={line.title}
                >
                    {line.text}
                </span>
            ))}
        </>
    );
}

function temperature(value: number | undefined): string | null {
    return value !== undefined && Number.isFinite(value) && value > 0 && value < 125 ? `${Math.round(value)}°C` : null;
}

/**
 * Whether GPU tiles render on the card.
 *
 * Off for now: GPU load is not something this wall needs, but the tile code
 * is kept intact so a box that reports a GPU still works the moment this is
 * flipped back on. Nothing else in the card depends on it.
 */
const SHOW_GPU = false;

/** Stable empty list, so a card without backup agents keeps its memo. */
const NO_BACKUPS: BackupAgentSummary[] = [];

/** Host reachability stays distinct from workload health and data freshness. */
export const FleetCard = memo(function FleetCard({
    server,
    backups = NO_BACKUPS,
    covered,
    stale,
    peakFresh,
    onOpenHistory,
    onMenu,
}: {
    server: FleetServer;
    /** Monitor ids some active mute covers (the board derives them from the listing). */
    covered: ReadonlySet<number>;
    /** Backup agents linked to this server's monitor (the board groups them). */
    backups?: BackupAgentSummary[];
    /** Computed by the board on its freshness tick, so the memo holds between flips. */
    stale: boolean;
    /** Whether `server.cpuPeak10m` is still inside its 10-minute window. */
    peakFresh: boolean;
    onOpenHistory: (id: number) => void;
    onMenu: (e: MouseEvent, monitor: MonitorSummary) => void;
}) {
    const { monitor, metrics, time } = server;
    const { containers, issues, hot } = fleetAttention(metrics, time, monitor.interval || 60);
    const down = monitor.status === 0;
    const hostLabel =
        ({ 0: "Host down", 1: "Host up", 2: "Pending", 3: "Maintenance" } as Record<number, string>)[monitor.status] ??
        "Unknown";
    // A hosted website's trouble degrades the server card too: the operator
    // watching the wall should see it without opening anything.
    const links = sortLinks(server.links ?? []);
    const websitesDown = links.filter((link) => link.status === 0).length;
    const websitesPending = links.filter((link) => link.status === 2).length;
    const websitesUp = links.filter((link) => link.status === 1).length;
    // An overdue or failed backup flags the card (never as "bad": a host or
    // website being down is more severe) and counts on the board.
    const behind = backupAttention(backups);
    // A red card whose every down monitor is muted is an acknowledged
    // outage: dark red, not an alarm.
    const mute = cardMute(monitor, links, covered);
    const attention =
        down || websitesDown > 0
            ? mute.muted
                ? "muted"
                : "bad"
            : stale || issues > 0 || hot || monitor.status === 2 || websitesPending > 0 || behind.flagged > 0
              ? "warn"
              : "normal";
    const headline = down
        ? "Host down"
        : websitesDown > 0
          ? `${websitesDown} website${websitesDown === 1 ? "" : "s"} down`
          : stale
            ? "Stale data"
            : issues > 0
              ? `${issues} ${issues === 1 ? "issue" : "issues"}`
              : behind.headline
                ? behind.headline
                : hot
                  ? "High usage"
                  : websitesPending > 0
                    ? `${websitesPending} website${websitesPending === 1 ? "" : "s"} pending`
                    : hostLabel;
    const cpu = metrics.cpu;
    const mem = metrics.mem;
    const peak = server.cpuPeak10m && peakFresh ? server.cpuPeak10m.percent : undefined;
    const disk = metrics.disk?.reduce((worst, next) => ((next.percent ?? -1) > (worst.percent ?? -1) ? next : worst));
    const gpu = metrics.gpu;
    const gpus = gpu?.gpus?.length ? gpu.gpus : gpu?.available ? [gpu] : [];
    const running = containers.filter((c) => c.state === "running").length;
    // The agent collects containers every 10s; past a minute the list is
    // worth calling old, whatever the reason (slow daemon, error).
    const dockerAgeMs = containerAgeMs(metrics, time);
    const dockerAge = dockerAgeMs !== null && dockerAgeMs > 60_000 ? formatDuration(dockerAgeMs / 1000) : null;
    const hostname = metrics.host?.hostname;
    const displayName = monitor.name || hostname || "Unnamed server";
    const updates = updatesStatus(metrics.updates);
    const updatesTone =
        updates?.tone === "reboot"
            ? "text-bad fleet-reboot"
            : updates?.tone === "ok"
              ? "text-ok"
              : updates?.tone === "warn"
                ? "text-warn"
                : updates?.tone === "critical"
                  ? "text-critical"
                  : "";
    const agent = metrics.agent;
    // The monitor carries the acknowledged counter values, so the warning
    // line shows only what the operator has not cleared yet.
    const warning = agentWarnings(agent, monitor);
    const agentTip = agent
        ? `Agent ${agent.version ?? "unknown"}${Number.isFinite(agent.uptime) ? ` · running ${formatDuration(agent.uptime) ?? "0s"}` : ""}`
        : undefined;
    // Second line under the name: only uptime and agent version. OS and core
    // count are noise the operator can get from the machine itself.
    const subline = [
        metrics.host?.uptime ? `uptime ${formatDuration(metrics.host.uptime)}` : null,
        agent?.version ? `agent ${agent.version}` : null,
    ]
        .filter(Boolean)
        .join(" · ");
    // The backup agent's version sits right after the telemetry agent's.
    const backup = backupVersion(backups);
    const load = metrics.load;
    const loadTip =
        load && Number.isFinite(load.avg1)
            ? `Load average 1/5/15: ${(load.avg1 as number).toFixed(2)} / ${Number.isFinite(load.avg5) ? (load.avg5 as number).toFixed(2) : "—"} / ${Number.isFinite(load.avg15) ? (load.avg15 as number).toFixed(2) : "—"}`
            : null;
    const smart = smartWarning(metrics.smart);
    const rows = containerRows(containers);

    return (
        <article
            className="fleet-card"
            data-attention={attention}
            data-stale={stale || undefined}
            aria-label={`${displayName}: ${headline}${attention === "muted" ? ", muted" : ""}`}
            onContextMenu={(e) => {
                e.preventDefault();
                onMenu(e, monitor);
            }}
        >
            <header className="fleet-heading">
                <div className="min-w-0">
                    <h2 className="fleet-name truncate">
                        <button
                            type="button"
                            className="fleet-history-link"
                            onClick={() => onOpenHistory(monitor.id)}
                            aria-label={`Open load history for ${displayName}`}
                            title={
                                hostname && hostname !== displayName
                                    ? `${displayName} · hostname ${hostname} · View history`
                                    : `${displayName} · View history`
                            }
                        >
                            <ProviderLogo provider={monitor.provider} />
                            <span className="truncate">
                                {displayName}{" "}
                                <span aria-hidden="true" className="text-quiet">
                                    ↗
                                </span>
                            </span>
                        </button>
                    </h2>
                    {subline || backup ? (
                        <p className="fleet-secondary mt-1" title={agentTip}>
                            {subline}
                            {backup ? (
                                <>
                                    {subline ? " · " : null}
                                    <span
                                        className={`whitespace-nowrap${backup.tone === "warn" ? " text-warn" : ""}`}
                                        title={backup.title}
                                    >
                                        {backup.text}
                                    </span>
                                </>
                            ) : null}
                        </p>
                    ) : null}
                </div>
                <div className="fleet-health">
                    <span className="fleet-status">
                        <span className="size-2 rounded-full bg-current" />
                        {headline}
                    </span>
                    {attention === "muted" ? <MutedAge since={mute.since} /> : null}
                    <span className={`fleet-freshness tnum ${stale ? "text-warn" : "text-quiet"}`}>
                        {stale ? "Stale · " : "Updated "}
                        <SampleAge time={time} />
                    </span>
                </div>
            </header>
            {/* Under "Updated", right-aligned, but in its own full-width row:
                inside the header column the long lines widened it and
                truncated the server name. */}
            {backups.some((agent) => agent.credentialActive) ? (
                <div className="fleet-backups">
                    <BackupLines agents={backups} />
                </div>
            ) : null}

            {updates || warning ? (
                <div className="fleet-flags">
                    {updates ? (
                        <span
                            className={`fleet-secondary tnum ${updatesTone}`}
                            title={updates.title}
                            aria-label={`System updates: ${updates.label}`}
                        >
                            {updates.label}
                        </span>
                    ) : null}
                    {warning ? (
                        <span className="fleet-secondary text-warn" title={warning.title} role="status">
                            {warning.text}
                        </span>
                    ) : null}
                </div>
            ) : null}

            {/* CPU first, then RAM and Disk each on their own full-width row:
                the numbers read `RAM · 24 / 36 (GB)` with a slim bar under
                them, so nothing wraps in a narrow column. */}
            <div className="fleet-primary">
                <section className="fleet-primary-metric" aria-label="CPU utilization">
                    <div className="fleet-label">CPU{temperature(cpu?.temp) ? ` ${temperature(cpu?.temp)}` : ""}</div>
                    <div className="mt-2">
                        <CoreSquares values={cpu?.perCore} label="Core" />
                    </div>
                    <p
                        className="fleet-secondary mt-2"
                        title={`Highest observed total CPU load over the last 10 minutes${loadTip ? ` · ${loadTip}` : ""}; restart recovery uses archived snapshots`}
                    >
                        {`Peak 10m ${percentage(peak)}`}
                        {loadTip ? ` · load ${(load?.avg1 as number).toFixed(2)}` : ""}
                    </p>
                </section>
                <section className="fleet-primary-metric" aria-label="Memory utilization">
                    <p className="fleet-meter-line">
                        <span className="fleet-label">
                            RAM{temperature(mem?.temp) ? ` ${temperature(mem?.temp)}` : ""}
                        </span>
                        <span className="fleet-meter-value tnum">{formatBytesPair(mem?.used, mem?.total) ?? "—"}</span>
                    </p>
                    <UsageBar percent={mem?.percent} label="Memory" />
                </section>
                <section className="fleet-primary-metric" aria-label="Disk utilization">
                    <p className="fleet-meter-line">
                        <span className="fleet-label">
                            {disk && disk.mount && disk.mount !== "/" ? `Disk ${disk.mount}` : "Disk"}
                        </span>
                        <span className="fleet-meter-value tnum">
                            {formatBytesPair(disk?.used, disk?.total) ?? "No mounts reported"}
                        </span>
                    </p>
                    <UsageBar percent={disk?.percent} label="Disk" />
                </section>
            </div>

            {smart || (SHOW_GPU && gpus.length) ? (
                <div className="fleet-resources">
                    {smart ? (
                        <p
                            className={`fleet-secondary ${smart.tone === "bad" ? "text-bad" : "text-warn"}`}
                            title={smart.title}
                            role="status"
                        >
                            {smart.text}
                        </p>
                    ) : null}
                    {SHOW_GPU
                        ? gpus.map((g, i) => (
                              <section key={`${g.name}-${i}`} className="fleet-gpu">
                                  <MetricBar
                                      label={g.name ?? `GPU ${i + 1}`}
                                      percent={g.util}
                                      detail={temperature(g.temp) ?? undefined}
                                  />
                                  {g.memTotal !== undefined && g.memTotal > 0 ? (
                                      <MetricBar
                                          label="VRAM"
                                          percent={g.memUsed !== undefined ? (g.memUsed / g.memTotal) * 100 : undefined}
                                          detail={`${formatBytes(g.memUsed)} / ${formatBytes(g.memTotal)}`}
                                      />
                                  ) : null}
                              </section>
                          ))
                        : null}
                </div>
            ) : null}

            {rows.length || metrics.dockerError ? (
                <section className="fleet-containers" aria-label="Containers">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                        <h3 className="fleet-label">Containers</h3>
                        <span className="fleet-secondary tnum">
                            {running}/{containers.length} running
                        </span>
                    </div>
                    {metrics.dockerError ? (
                        <p className="fleet-secondary text-warn" title={metrics.dockerError} role="status">
                            {dockerAge
                                ? `Collection failing — containers as of ${dockerAge} ago`
                                : "Collection unavailable — container health unknown"}
                        </p>
                    ) : dockerAge ? (
                        <p className="fleet-secondary text-warn" role="status">
                            Containers as of {dockerAge} ago
                        </p>
                    ) : null}
                    {rows.length ? <ContainerRows containers={rows} /> : null}
                </section>
            ) : null}

            {links.length ? (
                <section className="fleet-links" aria-label="Hosted websites">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                        <h3 className="fleet-label">Websites</h3>
                        <span className="fleet-secondary tnum">
                            {websitesDown > 0 ? <span className="text-bad">{websitesDown} down · </span> : null}
                            {websitesUp}/{links.length} up
                        </span>
                    </div>
                    <div className="fleet-link-grid">
                        {links.map((link) => (
                            <span
                                key={link.id}
                                className="fleet-link-chip"
                                data-tone={linkTone(link.status)}
                                title={`${link.name} — ${linkStatusLabel(link.status)}${link.ping != null ? ` · ${Math.round(link.ping)}ms` : ""}${link.lastCheck ? ` · last check ${link.lastCheck}` : ""}`}
                            >
                                <LinkStatusDot status={link.status} />
                                <span className="truncate">{link.name}</span>
                            </span>
                        ))}
                    </div>
                </section>
            ) : null}
        </article>
    );
});
