/**
 * Live event coalescing for the board: heartbeats are queued and applied in
 * one render per window instead of one render per event.
 */

import type { MonitorSummary } from "./api";

export interface LiveBeat {
    monitorId: number;
    patch: Partial<MonitorSummary>;
}

/**
 * Queue that flushes at most once per `intervalMs`, can be paused (items keep
 * accumulating) and resumed (one flush).
 */
export class EventBatcher<T> {
    private items: T[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private held = false;

    constructor(
        private readonly intervalMs: number,
        private readonly onFlush: (items: T[]) => void,
        /** Oldest items are dropped past this size; a resnapshot repairs the loss. */
        private readonly maxItems = 20_000
    ) {}

    get size(): number {
        return this.items.length;
    }

    get paused(): boolean {
        return this.held;
    }

    push(item: T): void {
        this.items.push(item);
        if (this.items.length > this.maxItems) {
            this.items.splice(0, this.items.length - this.maxItems);
        }
        if (!this.held && this.timer === null) {
            this.timer = setTimeout(() => this.flush(), this.intervalMs);
        }
    }

    /** Apply what is queued now (no-op while paused). */
    flush(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.held || this.items.length === 0) {
            return;
        }
        const batch = this.items;
        this.items = [];
        this.onFlush(batch);
    }

    pause(): void {
        this.held = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    resume(): void {
        this.held = false;
        this.flush();
    }

    /** Drop everything queued (a newer snapshot supersedes it). */
    clear(): void {
        this.items = [];
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    dispose(): void {
        this.clear();
    }
}

/**
 * Merge a batch into one patch per monitor (later events win) and keep the
 * ordered beats for strip placement.
 */
export function coalesceBeats(events: LiveBeat[]): {
    patches: Map<number, Partial<MonitorSummary>>;
    beats: LiveBeat[];
} {
    const patches = new Map<number, Partial<MonitorSummary>>();
    for (const event of events) {
        patches.set(event.monitorId, { ...patches.get(event.monitorId), ...event.patch });
    }
    return { patches, beats: events };
}

/**
 * Apply patches to the roster. Untouched monitors keep their identity, and the
 * same array comes back when nothing differs.
 */
export function applyPatches(
    monitors: MonitorSummary[],
    patches: Map<number, Partial<MonitorSummary>>
): MonitorSummary[] {
    let changed = false;
    const next = monitors.map((monitor) => {
        const patch = patches.get(monitor.id);
        if (!patch) {
            return monitor;
        }
        changed = true;
        return { ...monitor, ...patch };
    });
    return changed ? next : monitors;
}

/** Ids whose status (or paused state) differs between two rosters. */
export function changedStatusIds(previous: MonitorSummary[], next: MonitorSummary[]): number[] {
    const before = new Map(previous.map((m) => [m.id, m.status]));
    const ids: number[] = [];
    for (const monitor of next) {
        const was = before.get(monitor.id);
        if (was !== undefined && was !== monitor.status) {
            ids.push(monitor.id);
        }
    }
    return ids;
}
