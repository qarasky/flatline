import { ageOf, isSampleStale } from "@/lib/fleet-presentation";
import type { CPUPeak, MetricsPayload, MonitorSummary } from "@/lib/monitor-types";

/** A server's latest metrics sample, as the bulk and single reads return it. */
export interface ServerSample {
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
}

export interface ServerRow {
    cpu: number | null;
    ram: number | null;
    /** The fullest mount's use, in percent. */
    disk: number | null;
    agentVersion: string | null;
    freshness: "none" | "fresh" | "stale";
    /** Says in words how old the numbers are, so a stale row never passes for live. */
    ageText: string;
}

const percent = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

/** What a Servers row shows for one push monitor and its latest sample. */
export function serverRow(
    monitor: Pick<MonitorSummary, "interval">,
    sample: ServerSample | undefined,
    nowMs: number
): ServerRow {
    if (!sample) {
        return { cpu: null, ram: null, disk: null, agentVersion: null, freshness: "none", ageText: "No metrics yet" };
    }
    const { metrics, time } = sample;
    const disks = (metrics.disk ?? []).map((d) => percent(d.percent)).filter((p): p is number => p !== null);
    const stale = isSampleStale(metrics, time, monitor.interval, nowMs);
    const age = ageOf(time, nowMs);
    return {
        cpu: percent(metrics.cpu?.percent),
        ram: percent(metrics.mem?.percent),
        disk: disks.length > 0 ? Math.max(...disks) : null,
        agentVersion: metrics.agent?.version ?? null,
        freshness: stale ? "stale" : "fresh",
        ageText: stale ? `Stale: last sample ${age} ago` : `updated ${age} ago`,
    };
}
