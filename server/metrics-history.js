const { R } = require("redbean-node");

const FIELDS = ["cpu", "ram", "gpu", "vram"];
const MAX_HISTORY_ROWS = 50_000;

/**
 * Parse a stored metric timestamp (SQL or ISO) into epoch millis.
 * @param {string|number} value Timestamp to parse
 * @returns {number} Epoch millis, or NaN when unparseable
 */
function timestamp(value) {
    const text = String(value).replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`);
}

/**
 * Clamp a stored reading to a 0-100 percentage, or null when it is absent
 * or nonsense. Charts must never plot a corrupt value as a real load.
 * @param {unknown} value Raw reading
 * @returns {?number} Percentage, or null
 */
function percentage(value) {
    if (value === null || value === undefined || value === "" || value === "null") {
        return null;
    }
    const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Raw samples in a window, newest first, with only the scalar readings
 * extracted (never the repeated Docker inventories/full payloads).
 * JSON_VALID keeps a corrupt historical row from failing the whole request.
 * @param {number} monitorID Monitor to read
 * @param {string} from Window start (SQL timestamp)
 * @param {string} to Window end (SQL timestamp)
 * @param {number} limit Row cap
 * @returns {Promise<object[]>} Rows with time, cpu, ram, gpu_available, gpu, vram_used, vram_total
 */
async function scalarRows(monitorID, from, to, limit = MAX_HISTORY_ROWS + 1) {
    const payload = "CASE WHEN JSON_VALID(payload) THEN payload ELSE '{}' END";
    const extract = path => `JSON_EXTRACT(${payload}, '${path}')`;
    const gpu = field => `COALESCE(${extract(`$.gpu.gpus[0].${field}`)}, ${extract(`$.gpu.${field}`)})`;
    return R.getAll(`SELECT time,
        ${extract("$.cpu.percent")} AS cpu,
        ${extract("$.mem.percent")} AS ram,
        ${extract("$.gpu.available")} AS gpu_available,
        ${gpu("util")} AS gpu,
        ${gpu("memUsed")} AS vram_used,
        ${gpu("memTotal")} AS vram_total
        FROM monitor_metric WHERE monitor_id = ? AND time >= ? AND time <= ?
        ORDER BY time DESC, id DESC LIMIT ${limit}`, [monitorID, from, to]);
}

/**
 * Turn one extracted SQL row into 0-100 readings, applying the GPU
 * availability rule and the VRAM used/total ratio.
 * @param {object} row Row from scalarRows
 * @returns {{cpu: ?number, ram: ?number, gpu: ?number, vram: ?number}} Readings
 */
function readings(row) {
    const available = row.gpu_available === true || row.gpu_available === 1 || row.gpu_available === "true";
    const used = Number(row.vram_used);
    const total = Number(row.vram_total);
    return {
        cpu: percentage(row.cpu), ram: percentage(row.ram),
        gpu: available ? percentage(row.gpu) : null,
        vram: available && total > 0 && row.vram_used !== null ? percentage(used / total * 100) : null,
    };
}

/**
 * Extract readings from a raw stored payload, mirroring what scalarRows'
 * JSON_EXTRACT does in SQL (first GPU of `gpus`, falling back to the legacy
 * scalar fields; VRAM as used/total). Used by the hourly rollup, which reads
 * payloads in JS rather than through dialect-specific SQL.
 * @param {string} payload Stored metrics JSON
 * @returns {{cpu: ?number, ram: ?number, gpu: ?number, vram: ?number}} Readings
 */
function readingsFromPayload(payload) {
    let metrics;
    try {
        metrics = JSON.parse(payload);
    } catch {
        return { cpu: null, ram: null, gpu: null, vram: null };
    }
    const gpu = metrics?.gpu;
    const first = gpu?.gpus?.[0] ?? gpu;
    const available = gpu?.available === true;
    const used = Number(first?.memUsed);
    const total = Number(first?.memTotal);
    return {
        cpu: percentage(metrics?.cpu?.percent),
        ram: percentage(metrics?.mem?.percent),
        gpu: available ? percentage(first?.util) : null,
        vram: available && Number.isFinite(total) && total > 0 && first?.memUsed !== undefined
            ? percentage(used / total * 100) : null,
    };
}

/**
 * Nearest-rank summary over a list of readings.
 * @param {number[]} values Readings
 * @returns {?object} count/min/max/mean/p90/p95/p99, or null when empty
 */
function summarize(values) {
    if (!values.length) {
        return null;
    }
    values.sort((a, b) => a - b);
    const percentile = p => values[Math.max(0, Math.ceil(p * values.length) - 1)];
    return {
        count: values.length, min: values[0], max: values.at(-1),
        mean: values.reduce((sum, n) => sum + n, 0) / values.length,
        p90: percentile(0.90), p95: percentile(0.95), p99: percentile(0.99),
    };
}

/**
 * Build the chart/stats summary over reading rows.
 * @param {object[]} rows Rows with time and reading fields
 * @param {string} from Window start
 * @param {string} to Window end
 * @param {number} points Chart buckets
 * @returns {object} samples/firstSample/lastSample/bucketSeconds/stats/series
 */
function historySummary(rows, from, to, points = 240) {
    const start = timestamp(from);
    const end = timestamp(to);
    const bucketMs = Math.max(1000, Math.ceil((end - start) / points));
    const buckets = new Map();
    const values = Object.fromEntries(FIELDS.map(field => [field, []]));
    let first = null;
    let last = null;
    let samples = 0;
    for (const row of rows) {
        const time = timestamp(row.time);
        if (!Number.isFinite(time) || time < start || time > end) {
            continue;
        }
        const reading = readings(row);
        if (FIELDS.every(field => reading[field] === null)) {
            continue;
        }
        first = first === null ? time : Math.min(first, time);
        last = last === null ? time : Math.max(last, time);
        samples++;
        const index = Math.min(points - 1, Math.floor((time - start) / bucketMs));
        if (!buckets.has(index)) {
            buckets.set(index, Object.fromEntries(FIELDS.map(field => [field, []])));
        }
        for (const field of FIELDS) {
            if (reading[field] !== null) {
                values[field].push(reading[field]);
                buckets.get(index)[field].push(reading[field]);
            }
        }
    }
    const series = [...buckets.entries()].sort(([a], [b]) => a - b).map(([index, bucket]) => ({
        time: new Date(start + index * bucketMs).toISOString(),
        ...Object.fromEntries(FIELDS.map(field => [field, bucket[field].length
            ? bucket[field].reduce((sum, n) => sum + n, 0) / bucket[field].length : null])),
    }));
    return {
        samples,
        firstSample: first === null ? null : new Date(first).toISOString(),
        lastSample: last === null ? null : new Date(last).toISOString(),
        bucketSeconds: bucketMs / 1000,
        stats: Object.fromEntries(FIELDS.map(field => [field, summarize(values[field])])),
        series,
    };
}

/**
 * Hourly rollup rows for a monitor, newest first.
 *
 * The long tier: one row per hour with min/max/avg per metric and the
 * number of raw readings it represents. 50k rows covers two years at one
 * row per hour, so the cap is a guard against corrupt data, not a real
 * limit.
 * @param {number} monitorID Monitor to read
 * @param {string} from Window start (SQL timestamp)
 * @param {string} to Window end (SQL timestamp)
 * @param {number} limit Row cap
 * @returns {Promise<object[]>} Hourly buckets
 */
async function hourlyRows(monitorID, from, to, limit = MAX_HISTORY_ROWS + 1) {
    return R.getAll(`SELECT time, samples,
        cpu_min, cpu_max, cpu_avg,
        ram_min, ram_max, ram_avg,
        gpu_min, gpu_max, gpu_avg,
        vram_min, vram_max, vram_avg
        FROM monitor_metric_hourly WHERE monitor_id = ? AND time >= ? AND time <= ?
        ORDER BY time DESC LIMIT ${limit}`, [monitorID, from, to]);
}

/**
 * Summary over hourly rollups.
 *
 * Charts and percentiles describe hourly averages — that is what the tier
 * honestly has. The one thing averages must not lose is the peak: min and
 * max come from the stored extremes, so "Peak" stays the true maximum of
 * the underlying readings. `samples` reports the raw readings rolled up,
 * not the number of buckets, so the UI's "N archived snapshots" stays true.
 * @param {object[]} rows Hourly buckets from hourlyRows
 * @param {string} from Window start
 * @param {string} to Window end
 * @param {number} points Chart buckets
 * @returns {object} Same shape as historySummary
 */
function hourlySummary(rows, from, to, points = 240) {
    const mapped = rows.map((row) => ({
        time: row.time,
        cpu: percentage(row.cpu_avg),
        ram: percentage(row.ram_avg),
        gpu: percentage(row.gpu_avg),
        vram: percentage(row.vram_avg),
    }));
    const summary = historySummary(mapped, from, to, points);

    let samples = 0;
    const extremes = {};
    for (const field of FIELDS) {
        extremes[field] = { min: undefined, max: undefined };
    }
    for (const row of rows) {
        samples += Number(row.samples) || 0;
        for (const field of FIELDS) {
            const min = percentage(row[`${field}_min`]);
            if (min !== null && (extremes[field].min === undefined || min < extremes[field].min)) {
                extremes[field].min = min;
            }
            const max = percentage(row[`${field}_max`]);
            if (max !== null && (extremes[field].max === undefined || max > extremes[field].max)) {
                extremes[field].max = max;
            }
        }
    }
    for (const field of FIELDS) {
        const stats = summary.stats[field];
        const extreme = extremes[field];
        if (!stats) {
            continue;
        }
        if (extreme.min !== undefined) {
            stats.min = extreme.min;
        }
        if (extreme.max !== undefined) {
            stats.max = extreme.max;
        }
    }
    if (samples > 0) {
        summary.samples = samples;
    }

    return summary;
}

module.exports = {
    scalarRows,
    hourlyRows,
    historySummary,
    hourlySummary,
    readingsFromPayload,
    timestamp,
    percentage,
    MAX_HISTORY_ROWS,
};
