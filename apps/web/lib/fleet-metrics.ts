import type { CPUPeak, MetricsPayload } from "@/lib/monitor-types";
import type { ServerSample } from "@/lib/server-row";

/** One `metrics` event from the live stream. */
export interface MetricEvent {
    monitorId: number;
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
}

type ChunkAnswer = { samples: Record<number, ServerSample | null> };

/**
 * The samples after a chunked bulk read. A chunk that failed keeps what was
 * there before for its servers (so one bad chunk never blanks the rest) and
 * marks the read as failed, so the page can say so.
 */
export function mergeMetricChunks(
    chunks: number[][],
    results: PromiseSettledResult<ChunkAnswer>[],
    previous: Map<number, ServerSample>
): { samples: Map<number, ServerSample>; failed: boolean } {
    const samples = new Map<number, ServerSample>();
    let failed = false;
    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            for (const [id, sample] of Object.entries(result.value.samples)) {
                if (sample) {
                    samples.set(Number(id), sample);
                }
            }
            return;
        }
        failed = true;
        for (const id of chunks[index]) {
            const kept = previous.get(id);
            if (kept) {
                samples.set(id, kept);
            }
        }
    });
    return { samples, failed };
}

/** A batch of live samples applied in one copy; the last sample per server wins. */
export function applyMetricEvents(map: Map<number, ServerSample>, events: MetricEvent[]): Map<number, ServerSample> {
    if (events.length === 0) {
        return map;
    }
    const next = new Map(map);
    for (const event of events) {
        next.set(event.monitorId, { time: event.time, metrics: event.metrics, cpuPeak10m: event.cpuPeak10m });
    }
    return next;
}

/** An optional read: its failure is "nothing yet", not an error page. */
export function orNull<T>(promise: Promise<T>): Promise<T | null> {
    return promise.catch(() => null);
}
