import { ApiError } from "./api";
import { watchLive } from "./live-stream";
import type { LiveEvent } from "./monitor-types";

/**
 * One live stream per tab, shared by every view that wants updates.
 *
 * The backend caps SSE streams per token (8), and each stream costs a
 * snapshot on every reconnect. Views used to open their own stream — the
 * monitor detail view opened a second one next to the table's — so the hub
 * multiplexes them: the first subscriber opens the stream, the last one to
 * leave closes it, and events and errors fan out to everyone.
 *
 * Snapshots: on `ready`/`invalidate`/reconnect the stream's snapshot runs
 * every subscriber's snapshot in parallel (under watchLive's deadline and
 * coalescing). A subscriber that joins an already-open stream runs its own
 * snapshot once, immediately.
 */

export interface LiveSubscriber {
    /** Whether this subscriber needs `metrics` events (default true). */
    metrics?: boolean;
    snapshot: (signal?: AbortSignal) => Promise<void>;
    /** The stream (re)connected and its snapshot is current. */
    ready?: () => void;
    /** Backup agents or runs changed (a `backups` event). */
    backups?: () => void;
    event: (event: LiveEvent) => void;
    error: (error: Error) => void;
}

/** Deadline for a late joiner's own first snapshot. */
const JOIN_SNAPSHOT_TIMEOUT_MS = 15_000;

const subscribers = new Set<LiveSubscriber>();
const resyncListeners = new Set<() => void>();
let stopStream: (() => void) | null = null;
let streamHasMetrics = false;

function wantsMetrics(): boolean {
    for (const subscriber of subscribers) {
        if (subscriber.metrics !== false) {
            return true;
        }
    }
    return false;
}

function open(): void {
    streamHasMetrics = wantsMetrics();
    stopStream = watchLive({
        metrics: streamHasMetrics,
        snapshot: async (signal) => {
            for (const listener of resyncListeners) {
                listener();
            }
            // Wait for every snapshot before reporting, so a failing one does
            // not end the coalescing window while the others still run.
            const results = await Promise.allSettled([...subscribers].map((subscriber) => subscriber.snapshot(signal)));
            const failed = results.find((result) => result.status === "rejected");
            if (failed) {
                throw failed.reason;
            }
        },
        ready: () => {
            for (const subscriber of [...subscribers]) {
                subscriber.ready?.();
            }
        },
        backups: () => {
            for (const subscriber of [...subscribers]) {
                subscriber.backups?.();
            }
        },
        event: (event) => {
            for (const subscriber of [...subscribers]) {
                if (event.type === "metrics" && subscriber.metrics === false) {
                    continue;
                }
                subscriber.event(event);
            }
        },
        error: (error) => {
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                // watchLive has stopped itself; let the next subscriber (after
                // a new token is entered) open a fresh stream.
                stopStream = null;
            }
            for (const subscriber of [...subscribers]) {
                subscriber.error(error);
            }
        },
    });
}

function close(): void {
    stopStream?.();
    stopStream = null;
}

/**
 * Join the tab's live stream.
 * @param subscriber Snapshot, event and error callbacks
 * @returns Leave the stream (closes it when nobody is left)
 */
export function subscribeLive(subscriber: LiveSubscriber): () => void {
    subscribers.add(subscriber);
    if (!stopStream) {
        open();
    } else if (subscriber.metrics !== false && !streamHasMetrics) {
        // The open stream filters metrics out server-side; reopen with them.
        // The reconnect snapshots everyone, the newcomer included.
        close();
        open();
    } else {
        const abort = new AbortController();
        const deadline = setTimeout(() => abort.abort(new Error("Snapshot timed out")), JOIN_SNAPSHOT_TIMEOUT_MS);
        void Promise.resolve()
            .then(() => subscriber.snapshot(abort.signal))
            .catch((error) => {
                if (subscribers.has(subscriber)) {
                    subscriber.error(error instanceof Error ? error : new Error("Snapshot failed"));
                }
            })
            .finally(() => clearTimeout(deadline));
    }

    let left = false;
    return () => {
        if (left) {
            return;
        }
        left = true;
        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
            close();
        }
    };
}

/**
 * Be told whenever the stream (re)synchronises: on connect, reconnect and
 * `invalidate`. Used to piggyback cheap checks (a new deploy) on moments
 * when the connection was just re-established.
 * @returns Unsubscribe
 */
export function onLiveResync(listener: () => void): () => void {
    resyncListeners.add(listener);
    return () => resyncListeners.delete(listener);
}

/** Test hook: how many views share the stream, and whether it is open. */
export function liveHubState(): { subscribers: number; open: boolean; metrics: boolean } {
    return { subscribers: subscribers.size, open: stopStream !== null, metrics: streamHasMetrics };
}
