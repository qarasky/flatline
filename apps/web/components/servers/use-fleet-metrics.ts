"use client";

import { useEffect, useRef, useState } from "react";

import { chunkIds } from "@/lib/heartbeat-strip";
import { subscribeLive } from "@/lib/live-hub";
import { fetchLatestMetricsBulk } from "@/lib/monitors-api";
import type { ServerSample } from "@/lib/server-row";

/**
 * The latest metrics sample per server, kept live. Loads in chunks of 200
 * on each live snapshot (connect, reconnect, invalidate) and applies the
 * stream's `metrics` events in between. Shares the tab's one stream: the hub
 * upgrades it to carry metrics while this hook is mounted.
 */
export function useFleetMetrics(ids: number[]): Map<number, ServerSample> {
    const [samples, setSamples] = useState<Map<number, ServerSample>>(new Map());
    const idsRef = useRef(ids);
    idsRef.current = ids;
    const key = ids.join(",");

    useEffect(() => {
        let cancelled = false;
        async function snapshot(signal?: AbortSignal) {
            const wanted = idsRef.current;
            if (wanted.length === 0) {
                setSamples(new Map());
                return;
            }
            const results = await Promise.all(chunkIds(wanted).map((chunk) => fetchLatestMetricsBulk(chunk, signal)));
            if (cancelled) {
                return;
            }
            const next = new Map<number, ServerSample>();
            for (const result of results) {
                for (const [id, sample] of Object.entries(result.samples)) {
                    if (sample) {
                        next.set(Number(id), sample);
                    }
                }
            }
            setSamples(next);
        }
        const stop = subscribeLive({
            metrics: true,
            snapshot,
            event: (event) => {
                if (cancelled || event.type !== "metrics" || !idsRef.current.includes(event.monitorId)) {
                    return;
                }
                setSamples((prev) => {
                    const next = new Map(prev);
                    next.set(event.monitorId, {
                        time: event.time,
                        metrics: event.metrics,
                        cpuPeak10m: event.cpuPeak10m,
                    });
                    return next;
                });
            },
            // The board's provider already reports a broken stream.
            error: () => undefined,
        });
        return () => {
            cancelled = true;
            stop();
        };
        // A new set of servers needs a new first load.
    }, [key]);

    return samples;
}
