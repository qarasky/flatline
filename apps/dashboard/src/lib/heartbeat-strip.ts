/**
 * The 24 h heartbeat strip: bucket maths for
 * GET /api/v1/monitors/heartbeat-strips.
 *
 * Buckets are aligned to multiples of the bucket size since the Unix epoch, so
 * a live beat is placed without asking the server. Each bucket is
 * `[worstStatus, beats, failedBeats]` or `null` for no data.
 */

export type StripBucket = [status: number, beats: number, failed: number] | null;

export interface StripResponse {
    ok?: boolean;
    hours?: number;
    buckets?: number;
    bucketSeconds?: number;
    start?: string;
    strips?: Record<string, unknown>;
}

export interface Strip {
    /** Start of the first bucket, epoch ms. */
    startMs: number;
    bucketMs: number;
    cells: StripBucket[];
    /** Bumps when a live beat changes the newest bucket's status (drives the one-off cell fade). */
    fresh: number;
}

export const STRIP_HOURS = 24;
export const STRIP_BUCKETS = 48;
/** Flapping: at least this many status changes ... */
export const FLAP_CHANGES = 4;
/** ... within this many hours. */
export const FLAP_HOURS = 6;

/**
 * Parse a stored timestamp (SQL "YYYY-MM-DD HH:MM:SS" or ISO) as UTC.
 * @returns Epoch ms, NaN when unparseable
 */
export function parseTime(value: string | null | undefined): number {
    if (!value) {
        return NaN;
    }
    const iso = value.replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

/** Start of the bucket containing `ms`. */
export function bucketStartFor(ms: number, bucketMs: number): number {
    return Math.floor(ms / bucketMs) * bucketMs;
}

/** Start of the first bucket of a window whose last bucket contains `nowMs`. */
export function windowStart(nowMs: number, bucketMs: number, buckets: number): number {
    return bucketStartFor(nowMs, bucketMs) - (buckets - 1) * bucketMs;
}

/** Severity for worst-of merges: down > pending > maintenance > up. Unknown counts as up. */
export function severity(status: number): number {
    switch (status) {
        case 0:
            return 3;
        case 2:
            return 2;
        case 3:
            return 1;
        default:
            return 0;
    }
}

/** The worse of two statuses. */
export function worstStatus(a: number, b: number): number {
    return severity(b) > severity(a) ? b : a;
}

function cleanBucket(raw: unknown): StripBucket {
    if (!Array.isArray(raw) || raw.length < 3) {
        return null;
    }
    const [status, beats, failed] = raw;
    if (![status, beats, failed].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return null;
    }
    return [status, beats, failed];
}

/**
 * Turn a response into strips. Malformed strips are skipped (the row renders
 * without one); cell arrays are padded or trimmed to the announced length.
 */
export function stripsFromResponse(response: StripResponse): Map<number, Strip> {
    const out = new Map<number, Strip>();
    const startMs = parseTime(response.start);
    const bucketSeconds = response.bucketSeconds;
    const buckets = response.buckets;
    if (
        !Number.isFinite(startMs) ||
        typeof bucketSeconds !== "number" ||
        bucketSeconds <= 0 ||
        typeof buckets !== "number" ||
        buckets <= 0 ||
        !response.strips
    ) {
        return out;
    }
    for (const [key, raw] of Object.entries(response.strips)) {
        const id = Number(key);
        if (!Number.isInteger(id) || !Array.isArray(raw)) {
            continue;
        }
        const cells: StripBucket[] = [];
        for (let i = 0; i < buckets; i++) {
            cells.push(cleanBucket(raw[i]));
        }
        out.set(id, { startMs, bucketMs: bucketSeconds * 1000, cells, fresh: 0 });
    }
    return out;
}

/**
 * Slide a strip so its last bucket contains `nowMs`: the oldest buckets drop
 * off and empty ones appear at the end.
 */
export function alignStrip(strip: Strip, nowMs: number): Strip {
    const target = windowStart(nowMs, strip.bucketMs, strip.cells.length);
    const shift = Math.round((target - strip.startMs) / strip.bucketMs);
    if (shift <= 0) {
        return strip;
    }
    const length = strip.cells.length;
    const cells: StripBucket[] =
        shift >= length
            ? Array.from({ length }, () => null)
            : [...strip.cells.slice(shift), ...Array.from({ length: shift }, () => null)];
    return { ...strip, startMs: strip.startMs + shift * strip.bucketMs, cells };
}

/**
 * Place a live beat in its bucket (worst-of merge).
 * @param strip Current strip
 * @param atMs Beat time, epoch ms
 * @param status Beat status
 * @param nowMs Current time, so the window slides when a new bucket has begun
 * @returns The updated strip, or the same strip when the beat is older than the window
 */
export function placeBeat(strip: Strip, atMs: number, status: number, nowMs: number): Strip {
    const aligned = alignStrip(strip, Math.max(nowMs, atMs));
    const last = aligned.cells.length - 1;
    const index = Math.floor((atMs - aligned.startMs) / aligned.bucketMs);
    if (index < 0) {
        return aligned;
    }
    const target = Math.min(index, last);
    const cells = aligned.cells.slice();
    const current = cells[target];
    const failed = status === 0 ? 1 : 0;
    const merged: StripBucket = current
        ? [worstStatus(current[0], status), current[1] + 1, current[2] + failed]
        : [status, 1, failed];
    cells[target] = merged;
    const changedNewest = target === last && (!current || current[0] !== merged[0]);
    return { ...aligned, cells, fresh: changedNewest ? aligned.fresh + 1 : aligned.fresh };
}

/** Last non-null bucket index, or -1. */
function lastDataIndex(strip: Strip): number {
    for (let i = strip.cells.length - 1; i >= 0; i--) {
        if (strip.cells[i]) {
            return i;
        }
    }
    return -1;
}

/**
 * Status changes between consecutive buckets with data in the last `hours`.
 */
export function statusChangesWithin(strip: Strip, hours: number = FLAP_HOURS): number {
    const count = Math.min(strip.cells.length, Math.ceil((hours * 3_600_000) / strip.bucketMs));
    let previous: number | null = null;
    let changes = 0;
    for (const cell of strip.cells.slice(strip.cells.length - count)) {
        if (!cell) {
            continue;
        }
        if (previous !== null && previous !== cell[0]) {
            changes++;
        }
        previous = cell[0];
    }
    return changes;
}

export function isFlapping(strip: Strip | undefined): boolean {
    return strip ? statusChangesWithin(strip) >= FLAP_CHANGES : false;
}

/**
 * How long the newest run of `status` buckets has lasted, at bucket
 * resolution.
 * @returns Start of the run, and whether it reaches the start of the window
 *   (so the true start is earlier). Null when the newest data is not `status`.
 */
export function statusSince(strip: Strip, status: number): { sinceMs: number; atLeast: boolean } | null {
    const newest = lastDataIndex(strip);
    if (newest < 0 || strip.cells[newest]?.[0] !== status) {
        return null;
    }
    let first = newest;
    while (first > 0 && strip.cells[first - 1]?.[0] === status) {
        first--;
    }
    return { sinceMs: strip.startMs + first * strip.bucketMs, atLeast: first === 0 };
}

/**
 * When the status last changed, at bucket resolution; null when the window
 * shows one status throughout.
 */
export function lastChangeMs(strip: Strip | undefined): number | null {
    if (!strip) {
        return null;
    }
    const newest = lastDataIndex(strip);
    if (newest < 0) {
        return null;
    }
    const status = strip.cells[newest]?.[0];
    for (let i = newest - 1; i >= 0; i--) {
        const cell = strip.cells[i];
        if (cell && cell[0] !== status) {
            return strip.startMs + (i + 1) * strip.bucketMs;
        }
    }
    return null;
}

export interface BucketInfo {
    fromMs: number;
    toMs: number;
    status: number | null;
    beats: number;
    failed: number;
}

/** Facts about one bucket for the hover tooltip. */
export function bucketInfo(strip: Strip, index: number): BucketInfo | null {
    if (index < 0 || index >= strip.cells.length) {
        return null;
    }
    const cell = strip.cells[index];
    const fromMs = strip.startMs + index * strip.bucketMs;
    return {
        fromMs,
        toMs: fromMs + strip.bucketMs,
        status: cell ? cell[0] : null,
        beats: cell ? cell[1] : 0,
        failed: cell ? cell[2] : 0,
    };
}

/** Split ids into request-sized chunks (the endpoint takes at most 200). */
export function chunkIds(ids: number[], size = 200): number[][] {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += size) {
        chunks.push(ids.slice(i, i + size));
    }
    return chunks;
}

/** An empty strip shaped like `like`, ending in the bucket containing `nowMs`. */
export function blankStrip(like: Strip, nowMs: number): Strip {
    return {
        startMs: windowStart(nowMs, like.bucketMs, like.cells.length),
        bucketMs: like.bucketMs,
        cells: like.cells.map(() => null),
        fresh: 0,
    };
}
