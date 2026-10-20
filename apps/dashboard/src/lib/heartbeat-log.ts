/**
 * The monitor detail view's recent-checks list, kept current from live
 * `heartbeat` events instead of refetching 120 rows on every beat.
 */

export interface HeartbeatEntry {
    time: string;
    status: number;
    ping: number | null;
    msg: string;
    important: boolean;
}

/** The subset of a live heartbeat patch that describes the new beat. */
export interface HeartbeatPatch {
    status?: number;
    ping?: number | null;
    lastCheck?: string | null;
    lastMessage?: string | null;
}

/**
 * Prepend the beat a live `heartbeat` event describes.
 *
 * The event is published right after the row is written, so its
 * `lastCheck` is the new row's time. A patch without a time or status is not
 * a beat; a beat already at the head (the snapshot raced the event) is not
 * added twice. `important` marks a status change against the previous head.
 * @param beats Current list, newest first
 * @param patch Live heartbeat patch
 * @param limit Maximum length to keep
 * @returns The new list and whether a beat was added
 */
export function prependBeat(
    beats: HeartbeatEntry[],
    patch: HeartbeatPatch,
    limit: number
): { beats: HeartbeatEntry[]; added: boolean } {
    if (!patch.lastCheck || typeof patch.status !== "number") {
        return { beats, added: false };
    }
    if (beats.some((beat) => beat.time === patch.lastCheck)) {
        return { beats, added: false };
    }
    const head = beats[0];
    const beat: HeartbeatEntry = {
        time: patch.lastCheck,
        status: patch.status,
        ping: patch.ping ?? null,
        msg: patch.lastMessage ?? "",
        important: head ? head.status !== patch.status : true,
    };
    return { beats: [beat, ...beats].slice(0, Math.max(1, limit)), added: true };
}
