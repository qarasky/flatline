const { R } = require("redbean-node");
const { log } = require("../src/util");
const dayjs = require("dayjs");
const { publish } = require("./live-updates");
const latest = new Map();
const MAX_LATEST = 512;
const HISTORY_INTERVAL_MS = 30_000;
const { recordCPU, currentPeak, forgetCPU, resetCPU } = require("./cpu-peak");
const { asCounters, transformCounters } = require("./cpu-counters");

function metricTime(value) {
    const iso = String(value).replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

function getLatestMetrics(id) {
    const sample = latest.get(Number(id))?.sample;
    return sample ? { ...sample, cpuPeak10m: currentPeak(id) } : null;
}

function forgetMetrics(id) {
    latest.delete(Number(id));
    forgetCPU(id);
}

function resetMetricsCache() {
    latest.clear();
    resetCPU();
}

/**
 * Fleet metrics storage for Superboard.
 *
 * Latest state is cached per monitor; opted-in live pushes archive at 30s
 * resolution, while legacy pushes archive every payload. Payloads are stored
 * with server-derived CPU percentages when the agent sends raw counters
 * (see cpu-counters.js); legacy percent-only payloads pass through
 * untouched. Threshold evaluation, if it ever
 * comes, belongs in a separate layer, not in the ingest path.
 */

/**
 * Maximum accepted payload size in bytes.
 *
 * Matches the express.json() limit on the push route. An agent sending more
 * than this is misconfigured, not carrying useful data.
 * @type {number}
 */
const METRICS_MAX_BYTES = 64 * 1024;

/**
 * How long raw samples are kept, in days.
 * @type {number}
 */
const METRICS_RETENTION_DAYS = 30;

/**
 * Validate a metrics payload without interpreting it.
 *
 * Unknown fields are ignored, never rejected: the `v` envelope in the payload
 * lets future agents add fields without breaking old servers.
 * @param {unknown} payload Decoded `metrics` value from the push body
 * @returns {string} Canonical JSON string to store
 * @throws {Error} If the payload is not a plain object
 */
function validateMetrics(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("metrics must be a JSON object");
    }

    const encoded = JSON.stringify(payload);

    if (Buffer.byteLength(encoded, "utf8") > METRICS_MAX_BYTES) {
        throw new Error(`metrics payload exceeds ${METRICS_MAX_BYTES} bytes`);
    }

    return encoded;
}

/**
 * Round a derived percentage for storage. Board precision is a tenth of a
 * percent; two decimals keep payloads small and stable without losing
 * anything the peak tracker or charts can resolve.
 * @param {number} value Derived 0-100 percentage
 * @returns {number} Rounded value
 */
function roundPercent(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Apply a counter-derived transform to one decoded payload's cpu block.
 * Keeps the agent's per-core breakdown when the core shapes differ, and
 * records the core count from the snapshot that was actually measured.
 * @param {object} metrics Decoded metrics object (mutated)
 * @param {{ percent: number, perCore: number[] | null, cores: number }} derived Transform result
 */
function applyDerivedCPU(metrics, derived) {
    metrics.cpu = metrics.cpu && typeof metrics.cpu === "object" ? metrics.cpu : {};
    metrics.cpu.percent = roundPercent(derived.percent);
    if (derived.perCore) {
        metrics.cpu.perCore = derived.perCore.map(roundPercent);
        metrics.cpu.cores = derived.perCore.length;
    } else if (Number.isFinite(metrics.cpu.cores)) {
        metrics.cpu.cores = metrics.cpu.cores;
    } else if (derived.cores) {
        metrics.cpu.cores = derived.cores;
    }
}

/**
 * Store one metrics sample.
 * @param {number} monitorID Owning monitor
 * @param {string} time Timestamp, same clock as the heartbeat it rode in on
 * @param {unknown} payload Validated payload, or null/undefined to skip
 * @param {object} options Storage policy
 * @param {boolean} options.live Downsample durable history for live telemetry
 * @returns {Promise<boolean>} True if the sample was accepted
 */
async function storeMetrics(monitorID, time, payload, { live = false } = {}) {
    if (payload === undefined || payload === null) {
        return false;
    }

    const encoded = validateMetrics(payload);
    monitorID = Number(monitorID);
    const previous = latest.get(monitorID);
    const now = Date.now();
    let persistedAt = previous?.persistedAt ?? 0;

    // Server-side CPU derivation: when the agent sends raw cumulative
    // counters, percentages come from counter deltas, not the agent's
    // compat fields. Live/latest uses the short window since the previous
    // push (responsive); the archived row uses the long window since the
    // previous persist (~30s, representative). Anything incomputable —
    // first sight, resets, out-of-order arrivals — keeps the agent values.
    // The whole transform is best-effort: it must never fail a push.
    let rowEncoded = encoded;
    let sampleMetrics = JSON.parse(encoded);
    let pushCounters = previous?.pushCounters;
    let persistedCounters = previous?.persistedCounters;
    try {
        const incomingTime = metricTime(time);
        const cur = asCounters(JSON.parse(encoded).cpu);
        if (cur && Number.isFinite(incomingTime) &&
            (!previous?.pushCounters || incomingTime >= previous.pushCounters.time)) {
            if (previous?.pushCounters) {
                const liveDerived = transformCounters(previous.pushCounters.counters, cur);
                if (liveDerived) {
                    const forLatest = JSON.parse(encoded);
                    applyDerivedCPU(forLatest, liveDerived);
                    sampleMetrics = forLatest;
                }
            }
            pushCounters = { counters: cur, time: incomingTime };
            if (!live || now - persistedAt >= HISTORY_INTERVAL_MS) {
                if (previous?.persistedCounters) {
                    const archiveDerived = transformCounters(previous.persistedCounters.counters, cur);
                    if (archiveDerived) {
                        const forRow = JSON.parse(encoded);
                        applyDerivedCPU(forRow, archiveDerived);
                        rowEncoded = validateMetrics(forRow);
                    }
                }
                persistedCounters = { counters: cur, time: incomingTime };
            }
        } else if (cur && !previous && Number.isFinite(incomingTime)) {
            pushCounters = { counters: cur, time: incomingTime };
            if (!live || now - persistedAt >= HISTORY_INTERVAL_MS) {
                persistedCounters = { counters: cur, time: incomingTime };
            }
        }
    } catch (e) {
        log.debug("metrics", `CPU counter transform failed for monitor ${monitorID}, keeping agent values: ${e.message}`);
        rowEncoded = encoded;
        sampleMetrics = JSON.parse(encoded);
        pushCounters = previous?.pushCounters;
        persistedCounters = previous?.persistedCounters;
    }

    if (!live || now - persistedAt >= HISTORY_INTERVAL_MS) {
        const bean = R.dispense("monitor_metric");
        bean.monitor_id = monitorID;
        bean.time = time;
        bean.payload = rowEncoded;
        await R.store(bean);
        persistedAt = now;
    }
    const current = latest.get(monitorID);
    if (!current || metricTime(time) >= metricTime(current.sample.time)) {
        const sample = { time, metrics: sampleMetrics };
        const cpuPeak10m = await recordCPU(monitorID, time, sample.metrics.cpu?.percent);
        // Warming a new peak window is asynchronous; another push may have
        // committed a newer latest sample in the meantime.
        const newer = latest.get(monitorID);
        if (newer && metricTime(time) < metricTime(newer.sample.time)) { return true; }
        latest.delete(monitorID);
        latest.set(monitorID, { sample, persistedAt, pushCounters, persistedCounters });
        if (latest.size > MAX_LATEST) {
            latest.delete(latest.keys().next().value);
        }
        publish({ type: "metrics", monitorId: monitorID, ...sample, cpuPeak10m });
    }
    return true;
}

/**
 * Delete samples older than the retention window.
 * @param {number} days Keep window in days
 * @returns {Promise<number>} Rows deleted (best effort; drivers differ)
 */
async function pruneMetrics(days = METRICS_RETENTION_DAYS) {
    const cutoff = dayjs.utc().subtract(days, "day").format("YYYY-MM-DD HH:mm:ss");
    await R.exec("DELETE FROM monitor_metric WHERE time < ?", [ cutoff ]);
    log.debug("metrics", `Pruned metric samples older than ${days} days`);
}

module.exports = {
    METRICS_MAX_BYTES,
    METRICS_RETENTION_DAYS,
    validateMetrics,
    storeMetrics,
    pruneMetrics,
    getLatestMetrics,
    forgetMetrics,
    HISTORY_INTERVAL_MS,
    resetMetricsCache,
};
