"use client";

import { useEffect, useRef, useState } from "react";

import { applyMetricEvents, mergeMetricChunks, type MetricEvent } from "@/lib/fleet-metrics";
import { chunkIds } from "@/lib/heartbeat-strip";
import { EventBatcher } from "@/lib/live-batch";
import { subscribeLive } from "@/lib/live-hub";
import { fetchLatestMetricsBulk } from "@/lib/monitors-api";
import type { ServerSample } from "@/lib/server-row";

/** Live samples are applied at most this often: agents push every second, per server. */
const METRICS_BATCH_MS = 1000;

export interface FleetMetrics {
    samples: Map<number, ServerSample>;
    /** The first bulk read has answered (or failed). */
    loaded: boolean;
    /** The last bulk read failed for some servers; their numbers may be old. */
    failed: boolean;
}

/**
 * The latest metrics sample per server, kept live. Loads in chunks of 200
 * on each live snapshot (connect, reconnect, invalidate) and applies the
 * stream's `metrics` events once a second, holding them while the tab is
 * hidden. Shares the tab's one stream: the hub upgrades it to carry metrics
 * while this hook is mounted.
 */
export function useFleetMetrics(ids: number[]): FleetMetrics {
    const [state, setState] = useState<FleetMetrics>({ samples: new Map(), loaded: false, failed: false });
    const idsRef = useRef(ids);
    idsRef.current = ids;
    const key = ids.join(",");

    useEffect(() => {
        let cancelled = false;
        const batcher = new EventBatcher<MetricEvent>(METRICS_BATCH_MS, (events) => {
            if (!cancelled) {
                setState((prev) => ({ ...prev, samples: applyMetricEvents(prev.samples, events) }));
            }
        });
        const onVisibility = () => (document.hidden ? batcher.pause() : batcher.resume());
        document.addEventListener("visibilitychange", onVisibility);

        async function snapshot(signal?: AbortSignal) {
            const wanted = idsRef.current;
            const chunks = chunkIds(wanted);
            const results = await Promise.allSettled(chunks.map((chunk) => fetchLatestMetricsBulk(chunk, signal)));
            if (cancelled) {
                return;
            }
            batcher.clear();
            setState((prev) => {
                const merged = mergeMetricChunks(chunks, results, prev.samples);
                return { samples: merged.samples, loaded: true, failed: merged.failed };
            });
        }
        const stop = subscribeLive({
            metrics: true,
            snapshot,
            event: (event) => {
                if (event.type === "metrics" && idsRef.current.includes(event.monitorId)) {
                    batcher.push(event);
                }
            },
            // The board's provider reports a broken stream; a failed snapshot shows as `failed`.
            error: () => undefined,
        });
        return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", onVisibility);
            batcher.dispose();
            stop();
        };
        // A new set of servers needs a new first load.
    }, [key]);

    return state;
}
