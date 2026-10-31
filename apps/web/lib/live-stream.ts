/**
 * The live stream (`/api/v1/events`), read with fetch so a stalled
 * connection can be detected and replaced. Ported from the old dashboard's
 * `watchLive`; the only change is how it authenticates: the session cookie
 * rides along same-origin, and no token ever appears in a header or URL.
 */

import { ApiError } from "@/lib/api";
import type { LiveEvent } from "@/lib/monitor-types";

/** Fetch-based SSE, authenticated by the session cookie, never by URLs.
 * Reconnect resnapshots before applying buffered deltas, closing the race
 * between a REST snapshot and updates that arrive while it is loading.
 *
 * Snapshots run under their own deadline and never overlap: a roster or bulk
 * request that never settles used to stall the stream reader (and the
 * catch-path snapshot before it) forever, leaving `connected` true, no error
 * callback and no fallback polling — the audit's reproduction. Recovery now
 * schedules the reconnect independently of snapshot completion.
 */
export function watchLive(options: {
    metrics?: boolean;
    snapshot: (signal?: AbortSignal) => Promise<void>;
    event: (event: LiveEvent) => void;
    error: (error: Error) => void;
    /** Called after every (re)connect snapshot, for data the snapshot does not cover. */
    ready?: () => void;
    /** Backup agents, runs or verifications changed (the event carries no data). */
    backups?: () => void;
    /** Deadline for one snapshot; overridable for tests. */
    snapshotTimeoutMs?: number;
    /** Abort the stream after this much silence; overridable for tests. */
    watchdogMs?: number;
}): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let connected = false;
    let generation = 0;

    /** A hung snapshot must be abandoned, not awaited forever. */
    const SNAPSHOT_DEADLINE_MS = options.snapshotTimeoutMs ?? 15_000;
    /** Silence that means the stream is dead even if the socket is not. */
    const STREAM_WATCHDOG_MS = options.watchdogMs ?? 45_000;
    let snapshotAbort: AbortController | null = null;
    let snapshotInFlight: Promise<void> | null = null;

    /**
     * Run the snapshot under a deadline, refusing to overlap an in-flight
     * one. The abort signal is passed to the snapshot so its fetches are
     * actually cancelled, not just abandoned.
     * @returns Resolves when the snapshot finished; rejects on failure
     */
    function runSnapshot(): Promise<void> {
        if (snapshotInFlight) {
            return snapshotInFlight;
        }
        const abort = new AbortController();
        snapshotAbort = abort;
        const deadline = setTimeout(() => abort.abort(new Error("Snapshot timed out")), SNAPSHOT_DEADLINE_MS);
        const inflight = Promise.resolve()
            .then(() => options.snapshot(abort.signal))
            .finally(() => {
                clearTimeout(deadline);
                if (snapshotAbort === abort) {
                    snapshotAbort = null;
                }
                snapshotInFlight = null;
            });
        snapshotInFlight = inflight;
        return inflight;
    }

    /**
     * Await the snapshot, but give up as soon as the stream itself is dead.
     *
     * A snapshot that outlives its stream is re-joined by the reconnect
     * handler (snapshots never overlap), so the reader must not sit on it:
     * recovery is a property of the stream, not of the snapshot.
     * @param promise Snapshot in flight
     * @param signal The stream's abort signal
     * @returns The snapshot's result, or a rejection once the stream dies
     */
    function untilStreamDies<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new Error("Live stream aborted while snapshotting"));
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
                (value) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                }
            );
        });
    }

    async function connect() {
        if (stopped) {
            return;
        }
        const epoch = ++generation;
        controller = new AbortController();
        const currentController = controller;
        let watchdog = setTimeout(() => currentController.abort(), STREAM_WATCHDOG_MS);
        try {
            const response = await fetch(`/api/v1/events${options.metrics === false ? "?metrics=0" : ""}`, {
                headers: { Accept: "text/event-stream" },
                credentials: "same-origin",
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new ApiError(response.status, "live_stream", response.statusText);
            }
            if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
                throw new Error("Live stream unavailable");
            }
            connected = true;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                while (!stopped && epoch === generation) {
                    const chunk = await reader.read();
                    clearTimeout(watchdog);
                    watchdog = setTimeout(() => currentController.abort(), STREAM_WATCHDOG_MS);
                    if (chunk.done) {
                        throw new Error("Live connection closed; reconnecting");
                    }
                    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
                    if (buffer.length > 1024 * 1024) {
                        throw new Error("Live frame exceeds limit");
                    }
                    let boundary;
                    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                        if (stopped || epoch !== generation) {
                            break;
                        }
                        const frame = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        const data = frame
                            .split("\n")
                            .filter((line) => line.startsWith("data:"))
                            .map((line) => line.slice(5).trimStart())
                            .join("\n");
                        if (!data) {
                            continue;
                        }
                        const event = JSON.parse(data);
                        if (event.type === "unauthorized") {
                            throw new ApiError(401, "unauthorized", "Live token expired or revoked");
                        }
                        if (event.type === "ready" || event.type === "invalidate") {
                            await untilStreamDies(runSnapshot(), currentController.signal);
                            delay = 1000;
                            if (event.type === "ready" && !stopped && epoch === generation) {
                                options.ready?.();
                            }
                        } else if (event.type === "backups") {
                            if (!stopped && epoch === generation) {
                                options.backups?.();
                            }
                        } else if (
                            (event.type === "metrics" || event.type === "heartbeat") &&
                            !stopped &&
                            epoch === generation
                        ) {
                            options.event(event);
                        }
                    }
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        } catch (error) {
            if (stopped || epoch !== generation) {
                return;
            }
            connected = false;
            const failure = error instanceof Error ? error : new Error("Live stream disconnected");
            options.error(failure);
            if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
                stopped = true;
                clearInterval(fallback);
                return;
            }
            // Recover on a timer that does not depend on the snapshot: the
            // snapshot is bounded and coalesced, and the reconnect's own
            // reader awaits it before applying deltas anyway.
            retry = setTimeout(() => void connect(), delay + Math.random() * 500);
            delay = Math.min(15_000, delay * 2);
            void runSnapshot().catch(() => {
                /* reconnect retries the snapshot */
            });
        } finally {
            clearTimeout(watchdog);
        }
    }
    // Compatibility fallback while a proxy/server cannot stream. Never poll
    // whole rosters while the live connection is healthy, and never stack
    // snapshots: runSnapshot coalesces them and bounds each one.
    const fallback = setInterval(() => {
        if (!stopped && !connected && !document.hidden) {
            void runSnapshot().catch((error) => options.error(error));
        }
    }, 30_000);
    void connect();
    return () => {
        stopped = true;
        generation++;
        controller?.abort();
        snapshotAbort?.abort();
        clearTimeout(retry);
        clearInterval(fallback);
    };
}
