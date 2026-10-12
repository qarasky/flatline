const { R } = require("redbean-node");
const { log } = require("../src/util");
const dayjs = require("dayjs");
const { publish } = require("./live-updates");
const latest = new Map();
const MAX_LATEST = 512;
const HISTORY_INTERVAL_MS = 30_000;
const { recordCPU, currentPeak, forgetCPU, resetCPU } = require("./cpu-peak");
const { asCounters, transformCounters } = require("./cpu-counters");
const { netSnapshot, diskSnapshot, netRates, diskRates } = require("./io-rates");

/**
 * Parse a stored timestamp (SQL or ISO) into epoch millis.
 * @param {string|number} value Timestamp to parse
 * @returns {number} Epoch millis, or NaN when unparseable
 */
function metricTime(value) {
    const iso = String(value).replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

/**
 * Format epoch millis the way the database stores times (SQL, UTC).
 * @param {number} ms Epoch millis
 * @returns {string} SQL-formatted timestamp
 */
function sqlTimeMillis(ms) {
    return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Resolve an agent-supplied sample time, if it is trustworthy.
 *
 * Buffered agents (disk-backed send buffer) deliver telemetry late and
 * carry the time each sample was actually taken. Use it when present so a
 * backfilled history is honest about when things happened; reject it when
 * absent, unparseable, obviously in the future (clock skew), or older than
 * the retention window (it could never be archived). The caller falls back
 * to receive time. The clock authority stays the server: agent time is an
 * optimisation for backfill, never a requirement.
 * @param {unknown} sampledAt Agent-provided timestamp
 * @param {number} now Current epoch millis
 * @returns {string|null} SQL-formatted time, or null to use receive time
 */
function resolveSampleTime(sampledAt, now = Date.now()) {
    if (typeof sampledAt !== "string" || sampledAt.trim() === "") {
        return null;
    }
    const parsed = metricTime(sampledAt);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    if (parsed > now + 5 * 60_000) {
        return null;
    }
    if (parsed < now - METRICS_RETENTION_DAYS * 24 * 3600_000) {
        return null;
    }
    return sqlTimeMillis(parsed);
}

/**
 * The most recent cached sample for a monitor, with the rolling CPU peak.
 * @param {number} id Monitor id
 * @returns {?object} Sample plus cpuPeak10m, or null when nothing cached
 */
function getLatestMetrics(id) {
    const sample = latest.get(Number(id))?.sample;
    return sample ? { ...sample, cpuPeak10m: currentPeak(id) } : null;
}

/**
 * Drop the cached sample and CPU peak state for a monitor.
 * @param {number} id Monitor id
 * @returns {void}
 */
function forgetMetrics(id) {
    latest.delete(Number(id));
    forgetCPU(id);
}

/**
 * Clear every cached sample and CPU peak (tests, shutdown).
 * @returns {void}
 */
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
 * @returns {void}
 */
function applyDerivedCPU(metrics, derived) {
    metrics.cpu = metrics.cpu && typeof metrics.cpu === "object" ? metrics.cpu : {};
    metrics.cpu.percent = roundPercent(derived.percent);
    if (derived.perCore) {
        metrics.cpu.perCore = derived.perCore.map(roundPercent);
        metrics.cpu.cores = derived.perCore.length;
    } else if (!Number.isFinite(metrics.cpu.cores) && derived.cores) {
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
    const incomingTime = metricTime(time);
    let persistedAt = previous?.persistedAt ?? 0;
    let persistedSampleTime = previous?.persistedSampleTime ?? -Infinity;

    // An archive row is due when the wall clock says 30s have passed since
    // the last persist (normal live pacing) OR when the sample clock says
    // 30s of telemetry time have accumulated (a buffered agent draining a
    // backlog arrives quickly; its samples still archive at their real
    // cadence instead of collapsing into one receive-time burst).
    const persistDue = !live || now - persistedAt >= HISTORY_INTERVAL_MS ||
        (Number.isFinite(incomingTime) && incomingTime - persistedSampleTime >= HISTORY_INTERVAL_MS);

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
            if (persistDue) {
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
            if (persistDue) {
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

    // Network and disk I/O rates: same contract as CPU (raw counters in, the
    // server owns the window) but live-only — archived rows keep the raw
    // counters, which are lossless. A gap longer than the rate window
    // (restart, outage) produces no rate rather than a fake average.
    let pushNet = previous?.pushNet;
    let pushDiskIo = previous?.pushDiskIo;
    try {
        if (Number.isFinite(incomingTime)) {
            const netCur = netSnapshot(sampleMetrics);
            if (netCur && (!previous?.pushNet || incomingTime >= previous.pushNet.time)) {
                if (previous?.pushNet) {
                    const rate = netRates(previous.pushNet.snapshot, netCur, incomingTime - previous.pushNet.time);
                    if (rate) {
                        sampleMetrics.netRate = rate;
                    }
                }
                pushNet = { snapshot: netCur, time: incomingTime };
            }
            const ioCur = diskSnapshot(sampleMetrics);
            if (ioCur && (!previous?.pushDiskIo || incomingTime >= previous.pushDiskIo.time)) {
                if (previous?.pushDiskIo) {
                    const rate = diskRates(previous.pushDiskIo.snapshot, ioCur, incomingTime - previous.pushDiskIo.time);
                    if (rate) {
                        sampleMetrics.diskIoRate = rate;
                    }
                }
                pushDiskIo = { snapshot: ioCur, time: incomingTime };
            }
        }
    } catch (e) {
        log.debug("metrics", `I/O rate derivation failed for monitor ${monitorID}, omitting rates: ${e.message}`);
        pushNet = previous?.pushNet;
        pushDiskIo = previous?.pushDiskIo;
    }

    if (persistDue) {
        const bean = R.dispense("monitor_metric");
        bean.monitor_id = monitorID;
        bean.time = time;
        bean.payload = rowEncoded;
        await R.store(bean);
        persistedAt = now;
        if (Number.isFinite(incomingTime)) {
            persistedSampleTime = incomingTime;
        }
    }
    const current = latest.get(monitorID);
    if (!current || metricTime(time) >= metricTime(current.sample.time)) {
        const sample = { time, metrics: sampleMetrics };
        const cpuPeak10m = await recordCPU(monitorID, time, sample.metrics.cpu?.percent);
        // Warming a new peak window is asynchronous; another push may have
        // committed a newer latest sample in the meantime.
        const newer = latest.get(monitorID);
        if (newer && metricTime(time) < metricTime(newer.sample.time)) {
            return true;
        }
        latest.delete(monitorID);
        latest.set(monitorID, { sample, persistedAt, persistedSampleTime, pushCounters, persistedCounters, pushNet, pushDiskIo });
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
    resolveSampleTime,
};
