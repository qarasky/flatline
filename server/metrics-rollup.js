const { R } = require("redbean-node");
const { log } = require("../src/util");
const dayjs = require("dayjs");
const { readingsFromPayload, timestamp } = require("./metrics-history");

/**
 * Hourly rollups: the long tier of metrics history.
 *
 * Raw samples live 30 days at ~30s resolution. This job folds every
 * complete hour into one row per monitor — min, max, average per metric,
 * plus the number of raw readings — and keeps those for two years. The
 * history API reads the long tier for windows beyond seven days, where raw
 * data would blow the row cap anyway.
 *
 * Design notes:
 * - Coverage is decided per monitor and hour by comparing the raw sample
 *   count with the stored bucket's sample count. Durable buckets are keyed
 *   by (monitor_id, time), so a bucket is (re)built exactly when raw
 *   evidence exists that it does not represent yet — no hour is ever
 *   considered covered on another monitor's behalf, and a crash mid-backfill
 *   leaves a gap the next run simply fills. Buckets are upserted on
 *   (monitor_id, time), so re-runs are idempotent.
 * - Late samples also leave a dirty-hour marker at ingest. Buffered agents
 *   can deliver a sample more than two hours after it was taken, when no
 *   recency window would re-fold the hour; the marker forces it and is
 *   cleared once a run has looked at it. Markers for hours whose raw rows
 *   were already pruned are dropped without touching the bucket.
 * - Work is chunked by elapsed time (a gap splits a chunk rather than
 *   stretching it) and each chunk is folded page by page, so no single
 *   query materializes a long stretch of raw payloads. A first run
 *   backfills the full raw retention (30 days) without loading everything
 *   at once.
 * - Only complete hours roll up: the current hour is still accumulating.
 * - Folding and raw pruning are one maintenance run: the prune happens
 *   inside this job, after the fold, and only for (monitor, hour) pairs an
 *   hourly bucket provably covers. A failed or pending fold therefore
 *   keeps its raw evidence instead of racing a separately scheduled delete.
 */

/** How long hourly rollups are kept. Raw stays at METRICS_RETENTION_DAYS. */
const HOURLY_RETENTION_DAYS = 730;

/**
 * How long raw samples are kept, in days.
 *
 * Defined here rather than in `monitor-metrics.js` because both the rollup
 * and the raw prune need it, and `monitor-metrics` already depends on this
 * module for `markRollupDirty` (the reverse require would be a cycle). It is
 * re-exported from `monitor-metrics` for callers that know it from there.
 */
const METRICS_RETENTION_DAYS = 30;

/**
 * The oldest hour that still has complete raw evidence.
 *
 * Raw pruning removes whole hours (see `pruneRawMetrics`), so every hour at
 * or after this boundary is untouched and therefore complete; only such
 * hours may be (re)folded. An hour older than this can be missing part of
 * its rows — the hours pruned with an unaligned cutoff before this rule
 * existed — and rebuilding it from the survivors would replace a complete
 * aggregate with a partial one.
 * @param {number} now Current epoch millis
 * @returns {number} Boundary hour start in millis
 */
function rawBoundaryHour(now) {
    return hourStart(now - METRICS_RETENTION_DAYS * 24 * 3600_000);
}

/**
 * Widest span of elapsed time folded in one pass.
 *
 * It bounds elapsed time, not the number of missing hours: a single old gap
 * beside recent hours used to stretch one chunk across hundreds of hours
 * and pull every payload in between. A gap now splits the chunk.
 */
const CHUNK_HOURS = 6;

/** Raw rows fetched per query, bounding memory and lock time per page. */
const ROWS_PER_PAGE = 5000;

/**
 * Hours of raw evidence the repair sweep verifies per run.
 *
 * The sweep exists for damage the dirty markers cannot see (a pre-existing
 * gap, a marker write that failed). It walks the raw window in windows this
 * wide, one per run, so a full sweep costs about a day of runs instead of
 * scanning the whole window on every run.
 */
const REPAIR_WINDOW_HOURS = 24;

/** The newest complete hours are re-verified every run, wherever the sweep is. */
const REPAIR_OVERLAP_HOURS = 2;

/** State name of the repair sweep cursor. */
const REPAIR_CURSOR = "repair_cursor";

const FIELDS = [ "cpu", "ram", "gpu", "vram" ];

/** Prevents overlapping runs if a backfill takes longer than the interval. */
let running = false;

/**
 * Floor epoch millis to the start of its UTC hour.
 * @param {number} ms Epoch millis
 * @returns {number} Hour bucket start in millis
 */
function hourStart(ms) {
    return Math.floor(ms / 3600_000) * 3600_000;
}

/**
 * SQL timestamp for a bucket start, matching every other stored time.
 * @param {number} ms Bucket start millis
 * @returns {string} SQL-formatted timestamp
 */
function sqlTime(ms) {
    return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * The lowest SQL spelling of an hour start.
 *
 * Stored times are strings, and legacy/imported rows can carry whole seconds
 * instead of milliseconds. Compared as strings, the second-precision
 * spelling of an hour start sorts below its millisecond spelling, so a range
 * that must include an hour's first row whatever its precision starts from
 * the second-precision form.
 * Grouping is by hour, so including such a row can never put it in the wrong
 * bucket — and leaving it out would leave it unfolded, which the verified
 * prune would then refuse to delete forever.
 * @param {number} ms Hour start millis
 * @returns {string} SQL timestamp without fractional seconds
 */
function sqlTimeLowerBound(ms) {
    return sqlTime(ms).slice(0, 19);
}

/**
 * SQL expression that maps a stored sample time to its hour-key string.
 *
 * The rollup scan groups raw samples by hour in SQL so only one row per
 * monitor and hour crosses the wire, however many samples the hour holds.
 * SQLite and MySQL spell the formatting differently; pick by the connected
 * client.
 * @returns {string} SQL expression producing a "YYYY-MM-DD HH:00:00" string
 */
function hourKeyExpression() {
    const client = R.knex.client.config.client;
    if (client === "mysql2" || client === "mysql") {
        return "DATE_FORMAT(time, '%Y-%m-%d %H:00:00')";
    }
    return "strftime('%Y-%m-%d %H:00:00', replace(time, 'T', ' '))";
}

/**
 * Split due hours into time-ordered groups no wider than the chunk window,
 * so one pass never spans a long covered stretch just because a gap sits
 * beside recent hours.
 * @param {number[]} hours Sorted due hours (epoch millis)
 * @param {number} maxSpanHours Widest elapsed span per group
 * @returns {number[][]} Grouped hours
 */
function groupHours(hours, maxSpanHours = CHUNK_HOURS) {
    const groups = [];
    let group = [];
    for (const hour of hours) {
        if (group.length && hour - group[0] >= maxSpanHours * 3600_000) {
            groups.push(group);
            group = [];
        }
        group.push(hour);
    }
    if (group.length) {
        groups.push(group);
    }
    return groups;
}

/**
 * Start an empty accumulator for one (monitor, hour) bucket.
 *
 * Min/max/sum/count instead of keeping every reading: pages of one hour are
 * folded together as they arrive, so a chunk never holds the raw samples in
 * memory.
 * @param {number} monitorID Owning monitor
 * @param {number} hour Hour bucket start
 * @returns {object} Empty accumulator
 */
function emptyBucket(monitorID, hour) {
    const bucket = { monitorID, hour, samples: 0, sum: {}, count: {}, min: {}, max: {} };
    for (const field of FIELDS) {
        bucket.sum[field] = 0;
        bucket.count[field] = 0;
        bucket.min[field] = null;
        bucket.max[field] = null;
    }
    return bucket;
}

/**
 * Fold one raw row into the running accumulators.
 * @param {Map<string, object>} buckets Accumulators keyed by monitor and hour
 * @param {{monitor_id: number, time: string, payload: string}} row Raw row
 * @returns {void}
 */
function accumulateRow(buckets, row) {
    const time = timestamp(row.time);
    if (!Number.isFinite(time)) {
        return;
    }
    const hour = hourStart(time);
    const key = `${row.monitor_id}|${hour}`;
    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = emptyBucket(Number(row.monitor_id), hour);
        buckets.set(key, bucket);
    }
    bucket.samples++;
    const reading = readingsFromPayload(row.payload);
    for (const field of FIELDS) {
        const value = reading[field];
        if (value === null) {
            continue;
        }
        bucket.sum[field] += value;
        bucket.count[field]++;
        if (bucket.min[field] === null || value < bucket.min[field]) {
            bucket.min[field] = value;
        }
        if (bucket.max[field] === null || value > bucket.max[field]) {
            bucket.max[field] = value;
        }
    }
}

/**
 * Fold one chunk of raw rows into per-monitor, per-hour aggregates.
 *
 * Pure and exported for tests: takes rows in any order and returns a map of
 * `monitorID|hourMillis` to bucket accumulators.
 * @param {{monitor_id: number, time: string, payload: string}[]} rows Raw rows
 * @returns {Map<string, object>} Buckets keyed by monitor and hour
 */
function aggregateChunk(rows) {
    const buckets = new Map();
    for (const row of rows) {
        accumulateRow(buckets, row);
    }
    return buckets;
}

/**
 * Turn one aggregate bucket into a database row.
 * @param {object} bucket Aggregate from aggregateChunk
 * @returns {object} Row shaped for monitor_metric_hourly
 */
function bucketRow(bucket) {
    const row = { monitor_id: bucket.monitorID, time: sqlTime(bucket.hour), samples: bucket.samples };
    for (const field of FIELDS) {
        const count = bucket.count[field];
        row[`${field}_min`] = count ? bucket.min[field] : null;
        row[`${field}_max`] = count ? bucket.max[field] : null;
        row[`${field}_avg`] = count ? bucket.sum[field] / count : null;
    }
    return row;
}

/**
 * Upsert one bucket. The unique key makes a re-run harmless; knex's
 * onConflict handles the dialect differences.
 * @param {object} row Bucket row
 * @returns {Promise<void>} Resolves when stored
 */
async function storeBucket(row) {
    await R.knex("monitor_metric_hourly")
        .insert(row)
        .onConflict([ "monitor_id", "time" ])
        .merge();
}

/**
 * Record that one hour's bucket may be stale.
 *
 * Called when a raw sample is stored. A buffered agent can deliver a sample
 * into an hour that was already folded, and the count comparison alone would
 * only catch it when it changes the raw count of that hour; the marker is
 * the explicit "re-fold this hour" signal the next run acts on.
 * @param {number} monitorID Owning monitor
 * @param {string} time Stored sample time
 * @returns {Promise<void>} Resolves when recorded (duplicates are ignored)
 */
async function markRollupDirty(monitorID, time) {
    const ms = timestamp(time);
    if (!Number.isFinite(ms)) {
        return;
    }
    await R.knex("monitor_metric_rollup_dirty")
        .insert({ monitor_id: Number(monitorID), hour: sqlTime(hourStart(ms)) })
        .onConflict([ "monitor_id", "hour" ])
        .ignore();
}

/**
 * The stored repair cursor, or null when the sweep has never run.
 * @returns {Promise<?number>} Exclusive upper bound of the verified region
 */
async function readRepairCursor() {
    const value = await R.getCell(
        "SELECT value FROM monitor_metric_rollup_state WHERE name = ?", [ REPAIR_CURSOR ]);
    if (!value) {
        return null;
    }
    const hour = hourStart(timestamp(value));
    return Number.isFinite(hour) ? hour : null;
}

/**
 * Persist the repair cursor.
 * @param {number} hour Next exclusive upper bound of the verified region
 * @returns {Promise<void>} Resolves when stored
 */
async function writeRepairCursor(hour) {
    await R.knex("monitor_metric_rollup_state")
        .insert({ name: REPAIR_CURSOR, value: sqlTime(hour) })
        .onConflict([ "name" ])
        .merge();
}

/**
 * Forget the repair sweep cursor. The next run then reconciles the whole
 * retained window once, like the first run after this state was introduced —
 * the escape hatch when coverage is suspected to be wrong (tests, or an
 * operator after restoring a database).
 * @returns {Promise<void>} Resolves when cleared
 */
async function resetRollupState() {
    await R.exec("DELETE FROM monitor_metric_rollup_state WHERE name = ?", [ REPAIR_CURSOR ]);
}

/**
 * The next repair window: a bounded span of complete hours, walking backwards
 * from the newest hour and cycling over the raw window.
 *
 * The first run after this state exists (a fresh database, or the upgrade)
 * reconciles the whole retained window once — bounded by the 30-day raw
 * retention, not by how long the process has been up — so a fresh import does
 * not wait out a full sweep cycle to get its long tier.
 * @param {number} oldestHour Oldest hour with any raw evidence (the cycle
 * floor; hours below the retention boundary may hold survivors whose bucket
 * is missing, and those must stay reachable)
 * @param {number} newestHour Exclusive upper bound of complete hours
 * @returns {Promise<{start: number, end: number, firstRun: boolean}>} Window
 */
async function nextRepairWindow(oldestHour, newestHour) {
    const cursor = await readRepairCursor();
    if (cursor === null) {
        await writeRepairCursor(newestHour);
        return { start: oldestHour, end: newestHour, firstRun: true };
    }

    const start = Math.max(oldestHour, cursor - REPAIR_WINDOW_HOURS * 3600_000);
    const end = Math.max(start, Math.min(newestHour, cursor));
    const next = start <= oldestHour ? newestHour : start;
    await writeRepairCursor(next);
    return { start, end, firstRun: false };
}

/**
 * Mark every (monitor, hour) in a grouped count row set that needs a fold.
 *
 * Shared by the repair sweep and the recency overlap: both compare the raw
 * row count of an hour with its bucket, with the same guards as the dirty
 * path (never downgrade a richer bucket, leave the boundary hour alone).
 * @param {object[]} rows Grouped count rows
 * @param {number} boundaryHour Oldest hour with complete raw evidence
 * @param {Map<string, number>} stored Bucket sample counts by pair key
 * @param {Map<string, number>} rawCounts Raw counts by pair key (updated)
 * @param {Set<string>} needs Pairs to fold (updated)
 * @returns {void}
 */
function markDueFromCounts(rows, boundaryHour, stored, rawCounts, needs) {
    for (const row of rows) {
        const hour = hourStart(timestamp(row.hour));
        if (!Number.isFinite(hour)) {
            continue;
        }
        const key = `${row.monitor_id}|${hour}`;
        const rawSamples = Number(row.samples);
        rawCounts.set(key, rawSamples);
        const storedSamples = stored.get(key) ?? -1;
        if (hour <= boundaryHour && storedSamples >= 0) {
            // The boundary hour is the one an unaligned prune could have
            // split: a rebuild would replace a complete aggregate with the
            // survivors. A *missing* bucket is different — the survivors are
            // the only record left, so they are folded.
            continue;
        }
        if (storedSamples > rawSamples) {
            // The bucket covers more samples than the raw table still holds:
            // its evidence was pruned away. A rebuild could only lose history.
            log.debug("rollupMetrics", `Keeping richer bucket for ${key}: ${storedSamples} stored > ${rawSamples} raw`);
            continue;
        }
        if (storedSamples < rawSamples) {
            needs.add(key);
        }
    }
}

/**
 * Roll raw samples up into complete hours, then prune expired rollups.
 *
 * Idempotent: buckets are upserted and coverage is judged from the data, so
 * a crash or restart mid-backfill resumes rather than duplicating or losing
 * hours. Exported for the job and for tests, which pass a fixed `now`.
 *
 * Work selection is bounded per run: dirty hours (resolved with one indexed
 * count per pair), the newest complete hours, and one repair window. The
 * whole-window count comparison that used to run every hour — 864k raw rows
 * at ten hosts, ~750ms of blocking SQLite work in Node — only happens once,
 * on the first run after this state exists.
 * @param {number} now Current epoch millis
 * @returns {Promise<object>} Run summary
 */
async function rollupMetrics(now = Date.now()) {
    const lastCompleteHour = hourStart(now) - 3600_000;

    // Oldest raw sample defines how far back there is anything to fold.
    const oldest = await R.getCell("SELECT MIN(time) FROM monitor_metric");
    if (!oldest) {
        const pruned = await pruneHourly(now);
        return { rolledUp: 0, chunks: 0, pruned };
    }
    const oldestHour = hourStart(timestamp(oldest));
    if (!Number.isFinite(oldestHour) || oldestHour > lastCompleteHour) {
        const pruned = await pruneHourly(now);
        return { rolledUp: 0, chunks: 0, pruned };
    }

    const from = sqlTimeLowerBound(oldestHour);
    const to = sqlTime(lastCompleteHour);
    // Raw rows are stamped inside their hour, so the window ends at the next
    // hour start; bucket keys are stamped at the hour start itself.
    const toExclusive = sqlTime(lastCompleteHour + 3600_000);
    const boundaryHour = rawBoundaryHour(now);

    // Stored buckets inside the raw window: coverage is judged per monitor
    // and hour, because the durable bucket key is (monitor_id, time).
    const stored = new Map();
    for (const row of await R.getAll(
        "SELECT monitor_id, time, samples FROM monitor_metric_hourly WHERE time >= ? AND time < ?",
        [ from, toExclusive ])) {
        const hour = hourStart(timestamp(row.time));
        if (Number.isFinite(hour)) {
            stored.set(`${row.monitor_id}|${hour}`, Number(row.samples) || 0);
        }
    }

    const rawCounts = new Map();
    const needs = new Set();
    const rawCountOf = async (monitorID, hour) => {
        const count = Number(await R.getCell(
            "SELECT COUNT(*) FROM monitor_metric WHERE monitor_id = ? AND time >= ? AND time < ?",
            [ monitorID, sqlTimeLowerBound(hour), sqlTime(hour + 3600_000) ]));
        return Number.isFinite(count) ? count : 0;
    };
    const countsIn = (start, end) => R.getAll(
        `SELECT monitor_id, ${hourKeyExpression()} AS hour, COUNT(*) AS samples
         FROM monitor_metric WHERE time >= ? AND time < ?
         GROUP BY monitor_id, hour`,
        [ sqlTimeLowerBound(start), sqlTime(end) ]);

    // Dirty markers first: one indexed count per marked pair, so a late
    // sample is folded without looking at any other hour. A marker whose raw
    // rows were pruned, or whose hour predates the boundary, is dropped at
    // the end of the run without touching its bucket.
    for (const row of await R.getAll(
        "SELECT monitor_id, hour FROM monitor_metric_rollup_dirty WHERE hour >= ? AND hour <= ?",
        [ from, to ])) {
        const hour = hourStart(timestamp(row.hour));
        if (!Number.isFinite(hour) || hour <= boundaryHour) {
            continue;
        }
        const key = `${row.monitor_id}|${hour}`;
        const rawSamples = await rawCountOf(Number(row.monitor_id), hour);
        rawCounts.set(key, rawSamples);
        // Never rebuild from a partial raw set: a dirty hour whose bucket
        // already covers more samples than the raw table holds keeps it.
        if (rawSamples > 0 && (stored.get(key) ?? -1) <= rawSamples) {
            needs.add(key);
        }
    }

    // Repair sweep: one bounded window of older hours per run, plus the
    // newest complete hours every run, so damage without a dirty marker is
    // still found within a cycle.
    const sweep = await nextRepairWindow(Math.min(oldestHour, boundaryHour), lastCompleteHour + 3600_000);
    const overlapStart = Math.max(boundaryHour, lastCompleteHour - (REPAIR_OVERLAP_HOURS - 1) * 3600_000);
    const repairRows = await countsIn(sweep.start, sweep.end);
    markDueFromCounts(repairRows, boundaryHour, stored, rawCounts, needs);
    let verifiedHours = (sweep.end - sweep.start) / 3600_000;
    const overlapInsideSweep = overlapStart >= sweep.start && overlapStart < sweep.end;
    if (!overlapInsideSweep) {
        const overlapRows = await countsIn(overlapStart, lastCompleteHour + 3600_000);
        markDueFromCounts(overlapRows, boundaryHour, stored, rawCounts, needs);
        verifiedHours += REPAIR_OVERLAP_HOURS;
    }

    // Process the due pairs in time order. Chunks are bounded in elapsed
    // time (a gap splits them) and each chunk is folded page by page, so no
    // single query materializes a long stretch of raw payloads.
    const hours = [ ...new Set([ ...needs ].map((key) => Number(key.split("|")[1]))) ].sort((a, b) => a - b);
    let rolledUp = 0;
    let chunks = 0;
    for (const group of groupHours(hours)) {
        const windowStart = group[0];
        const windowEnd = group[group.length - 1] + 3600_000;
        chunks++;
        const buckets = new Map();
        let cursor = null;
        // Keyset pagination on (time, id): each page is bounded, and the
        // accumulators hold one entry per (monitor, hour), never the rows.
        for (;;) {
            const rows = cursor
                ? await R.getAll(
                    `SELECT id, monitor_id, time, payload FROM monitor_metric
                     WHERE time >= ? AND time < ? AND (time > ? OR (time = ? AND id > ?))
                     ORDER BY time, id LIMIT ${ROWS_PER_PAGE}`,
                    [ sqlTimeLowerBound(windowStart), sqlTime(windowEnd), cursor.time, cursor.time, cursor.id ])
                : await R.getAll(
                    `SELECT id, monitor_id, time, payload FROM monitor_metric
                     WHERE time >= ? AND time < ?
                     ORDER BY time, id LIMIT ${ROWS_PER_PAGE}`,
                    [ sqlTimeLowerBound(windowStart), sqlTime(windowEnd) ]);
            for (const row of rows) {
                accumulateRow(buckets, row);
            }
            if (rows.length < ROWS_PER_PAGE) {
                break;
            }
            const last = rows[rows.length - 1];
            cursor = { time: last.time, id: last.id };
        }

        for (const bucket of buckets.values()) {
            const key = `${bucket.monitorID}|${bucket.hour}`;
            if (!needs.has(key)) {
                continue;
            }
            await storeBucket(bucketRow(bucket));
            needs.delete(key);
            rolledUp++;
        }
    }

    // Every marker inside the processed range has been considered: re-folded
    // or dropped as evidence-free. A marker written while this run was
    // working is safe either way: if its raw row landed before the count
    // query it was folded, and if it landed after, the next run's count
    // comparison sees the new row.
    await R.exec("DELETE FROM monitor_metric_rollup_dirty WHERE hour <= ?", [ to ]);

    // Fold first, then prune what is proven folded: verification is part of
    // the maintenance run itself, not a separately scheduled job that merely
    // assumes the fold succeeded.
    const raw = await pruneRawSamples(now);
    const pruned = await pruneHourly(now);
    return {
        rolledUp,
        chunks,
        verifiedHours,
        pruned,
        prunedRaw: raw.deleted,
        skippedRaw: raw.skipped,
    };
}

/**
 * Delete raw samples older than the retention window, verified pair by pair.
 *
 * A pair — one (monitor, hour) — is deleted only when an hourly bucket covers
 * every remaining raw row of it. Rows whose hour is not (fully) folded stay
 * in place: the next run's repair folds them, and only then are they pruned.
 * That is the actual repair-before-prune guarantee, instead of the old
 * assumption that the daily schedule always ran after a successful fold.
 *
 * Called from [`rollupMetrics`], after the fold, so a fold failure or a
 * pending repair can never put deletion ahead of repair.
 * @param {number} now Current epoch millis
 * @param {number} days Raw retention in days
 * @returns {Promise<{deleted: number, skipped: number}>} Pairs deleted and
 * skipped because they are not folded yet
 */
async function pruneRawSamples(now = Date.now(), days = METRICS_RETENTION_DAYS) {
    const cutoffHour = hourStart(now - days * 24 * 3600_000);

    // Pairs that have aged out, with their remaining row counts.
    const expired = await R.getAll(
        `SELECT monitor_id, ${hourKeyExpression()} AS hour, COUNT(*) AS samples
         FROM monitor_metric WHERE time < ?
         GROUP BY monitor_id, hour`,
        [ sqlTime(cutoffHour) ]);
    if (!expired.length) {
        return { deleted: 0, skipped: 0 };
    }

    // Coverage: the stored bucket's sample count per pair.
    const pairs = [];
    let oldest = cutoffHour;
    for (const row of expired) {
        const hour = hourStart(timestamp(row.hour));
        if (!Number.isFinite(hour)) {
            continue;
        }
        pairs.push({ monitorID: Number(row.monitor_id), hour, samples: Number(row.samples) || 0 });
        oldest = Math.min(oldest, hour);
    }
    const covered = new Map();
    for (const row of await R.getAll(
        "SELECT monitor_id, time, samples FROM monitor_metric_hourly WHERE time >= ? AND time < ?",
        [ sqlTimeLowerBound(oldest), sqlTime(cutoffHour) ])) {
        const hour = hourStart(timestamp(row.time));
        if (Number.isFinite(hour)) {
            covered.set(`${row.monitor_id}|${hour}`, Number(row.samples) || 0);
        }
    }

    let deleted = 0;
    let skipped = 0;
    for (const pair of pairs) {
        const storedSamples = covered.get(`${pair.monitorID}|${pair.hour}`);
        if (storedSamples === undefined || storedSamples < pair.samples) {
            // Not folded (yet): keep the evidence and let the repair pass
            // fold it first. Pruning it now would lose those readings.
            skipped++;
            continue;
        }
        await R.exec(
            "DELETE FROM monitor_metric WHERE monitor_id = ? AND time >= ? AND time < ? AND time < ?",
            [ pair.monitorID, sqlTimeLowerBound(pair.hour), sqlTime(pair.hour + 3600_000), sqlTime(cutoffHour) ]);
        deleted++;
    }

    if (skipped > 0) {
        log.warn("rollupMetrics", `Kept ${skipped} expired raw hour(s) that are not fully folded yet`);
    }
    return { deleted, skipped };
}

/**
 * Delete rollups older than the long-tier retention.
 * @param {number} now Current epoch millis
 * @returns {Promise<number>} Rows deleted
 */
async function pruneHourly(now = Date.now()) {
    const cutoff = dayjs.utc(now).subtract(HOURLY_RETENTION_DAYS, "day").format("YYYY-MM-DD HH:mm:ss");
    // Counted before the delete: redbean's exec does not report affected
    // rows, and the count is what the job log wants to say.
    const expired = Number(await R.getCell("SELECT COUNT(*) FROM monitor_metric_hourly WHERE time < ?", [ cutoff ])) || 0;
    if (expired > 0) {
        await R.exec("DELETE FROM monitor_metric_hourly WHERE time < ?", [ cutoff ]);
    }
    return expired;
}

/**
 * Job entry point with an overlap guard: a large first backfill must not
 * stack with the next scheduled tick.
 * @returns {Promise<void>} Resolves when the run finishes
 */
async function rollupMetricsJob() {
    if (running) {
        log.debug("rollupMetrics", "Previous rollup still running; skipping this tick");
        return;
    }
    running = true;
    try {
        const result = await rollupMetrics();
        if (result.rolledUp || result.pruned) {
            log.info("rollupMetrics", `Rolled up ${result.rolledUp} hour buckets (${result.chunks} chunks), pruned ${result.pruned} expired`);
        }
    } catch (e) {
        log.error("rollupMetrics", `Rollup failed: ${e.message}`);
    } finally {
        running = false;
    }
}

module.exports = {
    rollupMetrics,
    rollupMetricsJob,
    pruneRawSamples,
    resetRollupState,
    markRollupDirty,
    aggregateChunk,
    accumulateRow,
    groupHours,
    bucketRow,
    hourStart,
    hourKeyExpression,
    sqlTimeLowerBound,
    rawBoundaryHour,
    HOURLY_RETENTION_DAYS,
    METRICS_RETENTION_DAYS,
    CHUNK_HOURS,
    ROWS_PER_PAGE,
};
