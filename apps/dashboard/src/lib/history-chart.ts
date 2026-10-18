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
