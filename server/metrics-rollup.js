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
 * - The job runs hourly and the raw prune daily, so a repair pass always has
 *   the raw evidence it needs; repairing missing/incomplete buckets happens
 *   before the prune of that same evidence.
 */

/** How long hourly rollups are kept. Raw stays at METRICS_RETENTION_DAYS. */
const HOURLY_RETENTION_DAYS = 730;

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
 * Roll raw samples up into complete hours, then prune expired rollups.
 *
 * Idempotent: buckets are upserted and coverage is judged from the data, so
 * a crash or restart mid-backfill resumes rather than duplicating or losing
 * hours. Exported for the job and for tests, which pass a fixed `now`.
 * @param {number} now Current epoch millis
 * @returns {Promise<{rolledUp: number, chunks: number, pruned: number}>} Run summary
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

    const from = sqlTime(oldestHour);
    const to = sqlTime(lastCompleteHour);
    // Raw rows are stamped inside their hour, so the window ends at the next
    // hour start; bucket keys are stamped at the hour start itself.
    const toExclusive = sqlTime(lastCompleteHour + 3600_000);

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

    // Raw evidence per monitor and hour, grouped in SQL: one row per pair no
    // matter how many samples it holds. A bucket is due when it does not
    // exist yet or holds fewer samples than the raw rows that now exist for
    // its hour — the case a late backfill creates and the old per-hour
    // coverage check missed.
    const counts = await R.getAll(
        `SELECT monitor_id, ${hourKeyExpression()} AS hour, COUNT(*) AS samples
         FROM monitor_metric WHERE time >= ? AND time < ?
         GROUP BY monitor_id, hour`,
        [ from, toExclusive ]);
    const evidence = new Set();
    const needs = new Set();
    for (const row of counts) {
        const hour = hourStart(timestamp(row.hour));
        if (!Number.isFinite(hour)) {
            continue;
        }
        const key = `${row.monitor_id}|${hour}`;
        evidence.add(key);
        if ((stored.get(key) ?? -1) < Number(row.samples)) {
            needs.add(key);
        }
    }

    // Dirty markers: hours whose samples arrived after a run had already
    // folded them. Only an hour that still has raw evidence can be re-folded;
    // a marker whose raw rows were pruned is stale and just gets dropped.
    for (const row of await R.getAll(
        "SELECT monitor_id, hour FROM monitor_metric_rollup_dirty WHERE hour >= ? AND hour <= ?",
        [ from, to ])) {
        const hour = hourStart(timestamp(row.hour));
        if (!Number.isFinite(hour)) {
            continue;
        }
        const key = `${row.monitor_id}|${hour}`;
        if (evidence.has(key)) {
            needs.add(key);
        }
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
                    [ sqlTime(windowStart), sqlTime(windowEnd), cursor.time, cursor.time, cursor.id ])
                : await R.getAll(
                    `SELECT id, monitor_id, time, payload FROM monitor_metric
                     WHERE time >= ? AND time < ?
                     ORDER BY time, id LIMIT ${ROWS_PER_PAGE}`,
                    [ sqlTime(windowStart), sqlTime(windowEnd) ]);
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

    const pruned = await pruneHourly(now);
    return { rolledUp, chunks, pruned };
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
    markRollupDirty,
    aggregateChunk,
    accumulateRow,
    groupHours,
    bucketRow,
    hourStart,
    hourKeyExpression,
    HOURLY_RETENTION_DAYS,
    CHUNK_HOURS,
    ROWS_PER_PAGE,
};
