import type { HistoryMetric, HistoryPoint } from "./api";

export function historyPath(
    series: HistoryPoint[],
    metric: HistoryMetric,
    from: string,
    to: string,
    bucketSeconds: number
): string {
    const start = Date.parse(from),
        range = Date.parse(to) - start;
    let previous = -Infinity;
    let connected = false;
    const commands: string[] = [];
    for (const point of series) {
        const time = Date.parse(point.time),
            value = point[metric];
        if (value === null || !Number.isFinite(value) || !Number.isFinite(time) || range <= 0) {
            connected = false;
            continue;
        }
        const x = 28 + ((time - start) / range) * 544;
        const y = 142 - (Math.max(0, Math.min(100, value)) / 100) * 126;
        const gap = time - previous > Math.max(90_000, bucketSeconds * 3000);
        commands.push(`${connected && !gap ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`);
        previous = time;
        connected = true;
    }
    return commands.join(" ");
}

/**
 * How often the history dialog refreshes a range. Short ranges move every
 * few seconds and are cheap; a 30-day or 1-year range barely changes in a
 * minute but costs a scan over hourly rollups, so it refreshes rarely.
 * @param hours Range length
 * @returns Refresh interval in milliseconds
 */
export function historyRefreshMs(hours: number): number {
    if (hours <= 1) {
        return 30_000;
    }
    if (hours <= 24) {
        return 60_000;
    }
    if (hours <= 168) {
        return 5 * 60_000;
    }
    return 15 * 60_000;
}

/**
 * Deadline for one history request, so a hung request cannot stop the
 * refreshes (the next one only starts after the previous settles).
 * @param hours Range length
 * @returns Timeout in milliseconds
 */
export function historyTimeoutMs(hours: number): number {
    return hours <= 24 ? 15_000 : 45_000;
}
