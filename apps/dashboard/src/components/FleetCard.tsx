import { memo } from "react";
import type { MonitorSummary, MetricsPayload, CPUPeak } from "@/lib/api";
import { fleetAttention, percentage, sampleAgeMs, updatesStatus } from "@/lib/fleet-presentation";
import { ContainerTiles } from "@/components/ContainerTiles";
import { CoreSquares } from "@/components/CoreSquares";
import { MetricBar, usageTone } from "@/components/MetricBar";

export interface FleetServer {
    monitor: MonitorSummary;
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
}

export function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes)) { return "—"; }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number | undefined): string | null {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) { return null; }
    if (seconds < 60) { return `${Math.floor(seconds)}s`; }
    if (seconds < 3600) { return `${Math.floor(seconds / 60)}m`; }
    if (seconds < 86400) { return `${Math.floor(seconds / 3600)}h`; }
    return `${Math.floor(seconds / 86400)}d`;
}

export function ageOf(value: string | null | undefined): string {
    if (!value) { return "—"; }
    const age = sampleAgeMs(value);
    return Number.isFinite(age) ? formatDuration(age / 1000) ?? "0s" : "—";
}

function temperature(value: number | undefined): string | null {
    return value !== undefined && Number.isFinite(value) && value > 0 && value < 125 ? `${Math.round(value)}°C` : null;
}

/** Host reachability stays distinct from workload health and data freshness. */
export const FleetCard = memo(function FleetCard({ server, now, onOpenHistory }: { server: FleetServer; now: number; onOpenHistory: (id: number) => void }) {
    const { monitor, metrics, time } = server;
    const { stale, containers, issues, hot } = fleetAttention(metrics, time, monitor.interval || 60, now);
    const down = monitor.status === 0;
    const hostLabel = ({ 0: "Host down", 1: "Host up", 2: "Pending", 3: "Maintenance" } as Record<number, string>)[monitor.status] ?? "Unknown";
    const attention = down ? "bad" : stale || issues > 0 || hot || monitor.status === 2 ? "warn" : "normal";
    const headline = down ? "Host down" : stale ? "Stale data" : issues > 0 ? `${issues} ${issues === 1 ? "issue" : "issues"}` : hot ? "High usage" : hostLabel;
    const cpu = metrics.cpu;
    const mem = metrics.mem;
    const peak = server.cpuPeak10m && sampleAgeMs(server.cpuPeak10m.at, now) <= 10 * 60_000 ? server.cpuPeak10m.percent : undefined;
    const disk = metrics.disk?.reduce((worst, next) => (next.percent ?? -1) > (worst.percent ?? -1) ? next : worst);
    const gpu = metrics.gpu;
    const gpus = gpu?.gpus?.length ? gpu.gpus : gpu?.available ? [gpu] : [];
    const running = containers.filter(c => c.state === "running").length;
    const hostname = metrics.host?.hostname;
    const displayName = monitor.name || hostname || "Unnamed server";
    const updates = updatesStatus(metrics.updates);
    const updatesTone = updates?.tone === "ok" ? "text-ok" : updates?.tone === "warn" ? "text-warn" : updates?.tone === "bad" ? "text-bad" : "text-critical";

    return (
        <article className="fleet-card" data-attention={attention} data-stale={stale || undefined} aria-label={`${displayName}: ${headline}`}>
            <header className="fleet-heading">
                <div className="min-w-0">
                    <h2 className="fleet-name truncate"><button type="button" className="fleet-history-link truncate max-w-full" onClick={() => onOpenHistory(monitor.id)}
                        aria-label={`Open load history for ${displayName}`} title={hostname && hostname !== displayName ? `${displayName} · hostname ${hostname} · View history` : `${displayName} · View history`}>{displayName} <span aria-hidden="true" className="text-quiet">↗</span></button></h2>
                    <p className="fleet-secondary mt-1">
                        {metrics.host?.os ?? monitor.type}{cpu?.cores ? ` · ${cpu.cores} cores` : ""}
                        {metrics.host?.uptime ? ` · uptime ${formatDuration(metrics.host.uptime)}` : ""}
                    </p>
                </div>
                <div className="fleet-health">
                    <span className="fleet-status"><span className="size-2 rounded-full bg-current" />{headline}</span>
                    {headline !== hostLabel ? <span className="fleet-secondary">{hostLabel}</span> : null}
                    <span className={`fleet-freshness tnum ${stale ? "text-warn" : "text-quiet"}`}>
                        {stale ? "Stale · " : "Updated "}{ageOf(time)} ago
                    </span>
                </div>
            </header>

            {updates ? (
                <p className={`fleet-secondary tnum ${updatesTone}`} title={updates.title} aria-label={`System updates: ${updates.label}`}>
                    {updates.label}
                </p>
            ) : null}

            <div className="fleet-primary">
                <section className="fleet-primary-metric" aria-label="CPU utilization">
                    <div className="fleet-label">CPU</div>
                    <div className={`fleet-number tnum ${usageTone(cpu?.percent) === "bad" ? "text-bad" : usageTone(cpu?.percent) === "warn" ? "text-warn" : ""}`}>{percentage(cpu?.percent)}</div>
                    <p className="fleet-secondary" title="Highest observed total CPU load over the last 10 minutes; restart recovery uses archived snapshots">
                        {`Peak 10m ${percentage(peak)}`}
                        {temperature(cpu?.temp) ? ` · ${temperature(cpu?.temp)}` : ""}
                    </p>
                    <div className="mt-3"><CoreSquares values={cpu?.perCore} label="Core" /></div>
                </section>
                <section className="fleet-primary-metric" aria-label="Memory utilization">
                    <div className="fleet-label">RAM</div>
                    <div className={`fleet-number tnum ${usageTone(mem?.percent) === "bad" ? "text-bad" : usageTone(mem?.percent) === "warn" ? "text-warn" : ""}`}>{percentage(mem?.percent)}</div>
                    <p className="fleet-secondary">{formatBytes(mem?.used)} / {formatBytes(mem?.total)}{temperature(mem?.temp) ? ` · ${temperature(mem?.temp)}` : ""}</p>
                    <div className="fleet-ram-track"><MetricBar label="Memory used" percent={mem?.percent} /></div>
                </section>
            </div>

            <div className="fleet-resources">
                <MetricBar label={disk ? `Disk ${disk.mount ?? ""}` : "Disk"} percent={disk?.percent}
                    detail={disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : "No mounts reported"} />
                {gpus.map((g, i) => (
                    <section key={`${g.name}-${i}`} className="fleet-gpu">
                        <MetricBar label={g.name ?? `GPU ${i + 1}`} percent={g.util} detail={temperature(g.temp) ?? undefined} />
                        {g.memTotal !== undefined && g.memTotal > 0 ? <MetricBar label="VRAM" percent={g.memUsed !== undefined ? g.memUsed / g.memTotal * 100 : undefined}
                            detail={`${formatBytes(g.memUsed)} / ${formatBytes(g.memTotal)}`} /> : null}
                    </section>
                ))}
            </div>

            <section className="fleet-containers" aria-label="Containers">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                    <h3 className="fleet-label">Containers</h3>
                    <span className="fleet-secondary tnum">{running}/{containers.length} running</span>
                </div>
                {metrics.dockerError ? <p className="fleet-secondary text-warn" title={metrics.dockerError}>Collection unavailable — container health unknown</p> : null}
                {!containers.length && !metrics.dockerError ? <p className="fleet-secondary">No containers</p> : null}
                {containers.length ? (
                    <ContainerTiles containers={containers} />
                ) : null}
            </section>
        </article>
    );
});
