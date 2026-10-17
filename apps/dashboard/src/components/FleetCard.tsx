import { memo, type MouseEvent } from "react";
import type { MonitorSummary, MetricsPayload, CPUPeak, ResolvedMonitorLink } from "@/lib/api";
import { agentWarnings, containerAgeMs, containerRows, fleetAttention, formatBytes, formatBytesPair, formatDuration, percentage, sampleAgeMs, smartWarning, updatesStatus } from "@/lib/fleet-presentation";
import { linkStatusLabel, linkTone, sortLinks } from "@/lib/links";
import { ContainerRows } from "@/components/ContainerRows";
import { CoreSquares } from "@/components/CoreSquares";
import { MetricBar, UsageBar } from "@/components/MetricBar";
import { ProviderLogo } from "@/components/ProviderLogo";
import { LinkStatusDot } from "@/components/WebsiteLinks";

export interface FleetServer {
    monitor: MonitorSummary;
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
    /** Linked websites hosted on this server, resolved worst-first on render. */
    links?: ResolvedMonitorLink[];
}

export function ageOf(value: string | null | undefined): string {
    if (!value) { return "—"; }
    const age = sampleAgeMs(value);
    return Number.isFinite(age) ? formatDuration(age / 1000) ?? "0s" : "—";
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

/** Host reachability stays distinct from workload health and data freshness. */
export const FleetCard = memo(function FleetCard({ server, now, onOpenHistory, onMenu }: {
    server: FleetServer;
    now: number;
    onOpenHistory: (id: number) => void;
    onMenu: (e: MouseEvent, monitor: MonitorSummary) => void;
}) {
    const { monitor, metrics, time } = server;
    const { stale, containers, issues, hot } = fleetAttention(metrics, time, monitor.interval || 60, now);
    const down = monitor.status === 0;
    const hostLabel = ({ 0: "Host down", 1: "Host up", 2: "Pending", 3: "Maintenance" } as Record<number, string>)[monitor.status] ?? "Unknown";
    // A hosted website's trouble degrades the server card too: the operator
    // watching the wall should see it without opening anything.
    const links = sortLinks(server.links ?? []);
    const websitesDown = links.filter((link) => link.status === 0).length;
    const websitesPending = links.filter((link) => link.status === 2).length;
    const websitesUp = links.filter((link) => link.status === 1).length;
    const attention = down || websitesDown > 0 ? "bad" : stale || issues > 0 || hot || monitor.status === 2 || websitesPending > 0 ? "warn" : "normal";
    const headline = down ? "Host down" : websitesDown > 0 ? `${websitesDown} website${websitesDown === 1 ? "" : "s"} down` : stale ? "Stale data" : issues > 0 ? `${issues} ${issues === 1 ? "issue" : "issues"}` : hot ? "High usage" : websitesPending > 0 ? `${websitesPending} website${websitesPending === 1 ? "" : "s"} pending` : hostLabel;
    const cpu = metrics.cpu;
    const mem = metrics.mem;
    const peak = server.cpuPeak10m && sampleAgeMs(server.cpuPeak10m.at, now) <= 10 * 60_000 ? server.cpuPeak10m.percent : undefined;
    const disk = metrics.disk?.reduce((worst, next) => (next.percent ?? -1) > (worst.percent ?? -1) ? next : worst);
    const gpu = metrics.gpu;
    const gpus = gpu?.gpus?.length ? gpu.gpus : gpu?.available ? [gpu] : [];
    const running = containers.filter(c => c.state === "running").length;
    // The agent collects containers every 10s; past a minute the list is
    // worth calling old, whatever the reason (slow daemon, error).
    const dockerAgeMs = containerAgeMs(metrics, time);
    const dockerAge = dockerAgeMs !== null && dockerAgeMs > 60_000 ? formatDuration(dockerAgeMs / 1000) : null;
    const hostname = metrics.host?.hostname;
    const displayName = monitor.name || hostname || "Unnamed server";
    const updates = updatesStatus(metrics.updates);
    const updatesTone = updates?.tone === "reboot" ? "text-bad fleet-reboot" : updates?.tone === "ok" ? "text-ok" : updates?.tone === "warn" ? "text-warn" : updates?.tone === "critical" ? "text-critical" : "";
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
    ].filter(Boolean).join(" · ");
    const load = metrics.load;
    const loadTip = load && Number.isFinite(load.avg1)
        ? `Load average 1/5/15: ${(load.avg1 as number).toFixed(2)} / ${Number.isFinite(load.avg5) ? (load.avg5 as number).toFixed(2) : "—"} / ${Number.isFinite(load.avg15) ? (load.avg15 as number).toFixed(2) : "—"}`
        : null;
    const smart = smartWarning(metrics.smart);
    const rows = containerRows(containers);

    return (
        <article
            className="fleet-card"
            data-attention={attention}
            data-stale={stale || undefined}
            aria-label={`${displayName}: ${headline}`}
            onContextMenu={(e) => {
                e.preventDefault();
                onMenu(e, monitor);
            }}
        >
            <header className="fleet-heading">
                <div className="min-w-0">
                    <h2 className="fleet-name truncate"><button type="button" className="fleet-history-link" onClick={() => onOpenHistory(monitor.id)}
                        aria-label={`Open load history for ${displayName}`} title={hostname && hostname !== displayName ? `${displayName} · hostname ${hostname} · View history` : `${displayName} · View history`}><ProviderLogo provider={monitor.provider} /><span className="truncate">{displayName} <span aria-hidden="true" className="text-quiet">↗</span></span></button></h2>
                    {subline ? <p className="fleet-secondary mt-1" title={agentTip}>{subline}</p> : null}
                </div>
                <div className="fleet-health">
                    <span className="fleet-status"><span className="size-2 rounded-full bg-current" />{headline}</span>
                    <span className={`fleet-freshness tnum ${stale ? "text-warn" : "text-quiet"}`}>
                        {stale ? "Stale · " : "Updated "}{ageOf(time)} ago
                    </span>
                </div>
            </header>

            {updates || warning ? (
                <div className="fleet-flags">
                    {updates ? (
                        <span className={`fleet-secondary tnum ${updatesTone}`} title={updates.title} aria-label={`System updates: ${updates.label}`}>
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
                    <div className="mt-2"><CoreSquares values={cpu?.perCore} label="Core" /></div>
                    <p className="fleet-secondary mt-2" title={`Highest observed total CPU load over the last 10 minutes${loadTip ? ` · ${loadTip}` : ""}; restart recovery uses archived snapshots`}>
                        {`Peak 10m ${percentage(peak)}`}
                        {loadTip ? ` · load ${(load?.avg1 as number).toFixed(2)}` : ""}
                    </p>
                </section>
                <section className="fleet-primary-metric" aria-label="Memory utilization">
                    <p className="fleet-meter-line">
                        <span className="fleet-label">RAM{temperature(mem?.temp) ? ` ${temperature(mem?.temp)}` : ""}</span>
                        <span className="fleet-meter-value tnum">{formatBytesPair(mem?.used, mem?.total) ?? "—"}</span>
                    </p>
                    <UsageBar percent={mem?.percent} label="Memory" />
                </section>
                <section className="fleet-primary-metric" aria-label="Disk utilization">
                    <p className="fleet-meter-line">
                        <span className="fleet-label">{disk && disk.mount && disk.mount !== "/" ? `Disk ${disk.mount}` : "Disk"}</span>
                        <span className="fleet-meter-value tnum">{formatBytesPair(disk?.used, disk?.total) ?? "No mounts reported"}</span>
                    </p>
                    <UsageBar percent={disk?.percent} label="Disk" />
                </section>
            </div>

            {smart || (SHOW_GPU && gpus.length) ? (
                <div className="fleet-resources">
                    {smart ? (
                        <p className={`fleet-secondary ${smart.tone === "bad" ? "text-bad" : "text-warn"}`} title={smart.title} role="status">
                            {smart.text}
                        </p>
                    ) : null}
                    {SHOW_GPU ? gpus.map((g, i) => (
                        <section key={`${g.name}-${i}`} className="fleet-gpu">
                            <MetricBar label={g.name ?? `GPU ${i + 1}`} percent={g.util} detail={temperature(g.temp) ?? undefined} />
                            {g.memTotal !== undefined && g.memTotal > 0 ? <MetricBar label="VRAM" percent={g.memUsed !== undefined ? g.memUsed / g.memTotal * 100 : undefined}
                                detail={`${formatBytes(g.memUsed)} / ${formatBytes(g.memTotal)}`} /> : null}
                        </section>
                    )) : null}
                </div>
            ) : null}

            {rows.length || metrics.dockerError ? (
                <section className="fleet-containers" aria-label="Containers">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                        <h3 className="fleet-label">Containers</h3>
                        <span className="fleet-secondary tnum">{running}/{containers.length} running</span>
                    </div>
                    {metrics.dockerError ? (
                        <p className="fleet-secondary text-warn" title={metrics.dockerError} role="status">
                            {dockerAge ? `Collection failing — containers as of ${dockerAge} ago` : "Collection unavailable — container health unknown"}
                        </p>
                    ) : dockerAge ? (
                        <p className="fleet-secondary text-warn" role="status">Containers as of {dockerAge} ago</p>
                    ) : null}
                    {rows.length ? (
                        <ContainerRows containers={rows} />
                    ) : null}
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
