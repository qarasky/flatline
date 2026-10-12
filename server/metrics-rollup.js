const { R } = require("redbean-node");
const { log } = require("../src/util");
const dayjs = require("dayjs");
const { readingsFromPayload } = require("./metrics-history");

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
 * - Coverage is decided by inspecting existing buckets, not a watermark: a
 *   crash mid-backfill leaves a gap the next run simply fills. Buckets are
 *   upserted on (monitor_id, time), so re-runs are idempotent.
 * - Work is chunked by time; each chunk reads only its window of raw rows.
 *   A first run backfills the full raw retention (30 days) without loading
 *   everything at once.
 * - Only complete hours roll up: the current hour is still accumulating.
 * - Runs before the daily raw prune keeps the ordering safe; the last two
 *   complete hours are re-rolled every run so late/backfilled samples land
 *   in an already-folded hour.
 */

/** How long hourly rollups are kept. Raw stays at METRICS_RETENTION_DAYS. */
const HOURLY_RETENTION_DAYS = 730;

/** Raw-row window processed per query, bounding memory and lock time. */
const CHUNK_HOURS = 6;

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
        const time = Date.parse(String(row.time).replace(" ", "T") + "Z");
        if (!Number.isFinite(time)) {
            continue;
        }
        const hour = hourStart(time);
        const key = `${row.monitor_id}|${hour}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { monitorID: Number(row.monitor_id), hour, samples: 0, values: {} };
            for (const field of FIELDS) {
                bucket.values[field] = [];
            }
            buckets.set(key, bucket);
        }
        bucket.samples++;
        const reading = readingsFromPayload(row.payload);
        for (const field of FIELDS) {
            if (reading[field] !== null) {
                bucket.values[field].push(reading[field]);
            }
        }
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
        const values = bucket.values[field];
        if (!values.length) {
            row[`${field}_min`] = null;
            row[`${field}_max`] = null;
            row[`${field}_avg`] = null;
            continue;
        }
        let min = values[0];
        let max = values[0];
        let sum = 0;
        for (const value of values) {
            if (value < min) {
                min = value;
            }
            if (value > max) {
                max = value;
            }
            sum += value;
        }
        row[`${field}_min`] = min;
        row[`${field}_max`] = max;
        row[`${field}_avg`] = sum / values.length;
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
 * Roll raw samples up into complete hours, then prune expired rollups.
 *
 * Idempotent: covered hours are skipped, so a crash or restart mid-backfill
 * resumes rather than duplicating or losing hours. Exported for the job and
 * for tests, which pass a fixed `now`.
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
    const oldestHour = hourStart(Date.parse(String(oldest).replace(" ", "T") + "Z"));
    if (!Number.isFinite(oldestHour) || oldestHour > lastCompleteHour) {
        const pruned = await pruneHourly(now);
        return { rolledUp: 0, chunks: 0, pruned };
    }

    // Covered hours: buckets that already exist. Hours without raw data
    // anywhere (whole fleet silent) have no bucket and get re-checked, which
    // is one cheap indexed range query per chunk. The last two complete
    // hours are always re-rolled: buffered agents can deliver late samples
    // into an hour that a previous run already folded, and an upsert merge
    // is cheaper than a wrong history.
    const coveredRows = await R.getAll("SELECT DISTINCT time FROM monitor_metric_hourly");
    const covered = new Set(coveredRows.map((row) => hourStart(Date.parse(String(row.time).replace(" ", "T") + "Z"))));
    const overlap = new Set([ lastCompleteHour, lastCompleteHour - 3600_000 ]);

    const missing = [];
    for (let hour = oldestHour; hour <= lastCompleteHour; hour += 3600_000) {
        if (!covered.has(hour) || overlap.has(hour)) {
            missing.push(hour);
        }
    }

    let rolledUp = 0;
    let chunks = 0;
    for (let i = 0; i < missing.length; i += CHUNK_HOURS) {
        const windowStart = missing[i];
        // The chunk may span covered hours (a gap in the middle); widen to
        // the last missing hour in this group and skip covered buckets when
        // storing. One extra range scan beats one query per hour.
        const windowEnd = Math.min(missing[Math.min(i + CHUNK_HOURS, missing.length) - 1] + 3600_000, lastCompleteHour + 3600_000);
        const rows = await R.getAll(
            "SELECT monitor_id, time, payload FROM monitor_metric WHERE time >= ? AND time < ?",
            [ sqlTime(windowStart), sqlTime(windowEnd) ]
        );
        chunks++;
        const buckets = aggregateChunk(rows);
        for (const bucket of buckets.values()) {
            if (covered.has(bucket.hour) && !overlap.has(bucket.hour)) {
                continue;
            }
            await storeBucket(bucketRow(bucket));
            covered.add(bucket.hour);
            rolledUp++;
        }
    }

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
    aggregateChunk,
    bucketRow,
    hourStart,
    HOURLY_RETENTION_DAYS,
    CHUNK_HOURS,
};
