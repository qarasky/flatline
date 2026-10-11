/**
 * Server-side CPU utilization from raw agent counters.
 *
 * Agents push cumulative CPU-time snapshots (`cpu.counters`) with every
 * sample; this module diffs consecutive snapshots into percentages. The
 * window is whatever separates the two snapshots: ~1s between pushes for
 * live readings, ~30s between archived rows for history. A one-second 95%
 * spike therefore averages down to ~3% in history instead of landing there
 * as a full 30-second load.
 *
 * All functions are pure and total: anything incomputable (no counters, no
 * previous snapshot, reset or stalled counters, out-of-order samples)
 * yields null, and the caller falls back to the agent's compat percent.
 * A broken collector must degrade to the old numbers, never to NaN or a
 * dropped sample.
 */

/**
 * Normalize the counters block of one payload into { total, idle, perCore }
 * tick counts, or null when absent or malformed.
 * @param {unknown} cpu The decoded `cpu` object of one metrics payload
 * @returns {{ total: number, idle: number, perCore: { total: number, idle: number }[] } | null}
 */
function asCounters(cpu) {
    if (!cpu || typeof cpu !== "object" || Array.isArray(cpu)) {
        return null;
    }
    const counters = cpu.counters;
    if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
        return null;
    }
    const pair = (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }
        const total = value.total, idle = value.idle;
        if (!Number.isFinite(total) || !Number.isFinite(idle) || total < 0 || idle < 0) {
            return null;
        }
        return { total, idle };
    };
    const aggregate = pair(counters);
    if (!aggregate) {
        return null;
    }
    const perCore = [];
    if (counters.perCore !== undefined) {
        if (!Array.isArray(counters.perCore)) {
            return null;
        }
        for (const entry of counters.perCore) {
            const core = pair(entry);
            if (!core) {
                return null;
            }
            perCore.push(core);
        }
    }
    return { total: aggregate.total, idle: aggregate.idle, perCore };
}

/**
 * Utilization between two cumulative snapshots, 0-100, or null when the
 * window carries no information (identical totals, reset/wrapped counters,
 * idle running ahead of total).
 * @param {{ total: number, idle: number }} prev Earlier snapshot
 * @param {{ total: number, idle: number }} cur Later snapshot
 * @returns {number | null}
 */
function utilization(prev, cur) {
    if (!prev || !cur) {
        return null;
    }
    if (!(cur.total > prev.total)) {
        return null;
    }
    if (cur.idle < prev.idle) {
        return null;
    }
    const totalDelta = cur.total - prev.total;
    const idleDelta = cur.idle - prev.idle;
    if (idleDelta > totalDelta) {
        return null;
    }
    const percent = (1 - idleDelta / totalDelta) * 100;
    return Math.min(100, Math.max(0, percent));
}

/**
 * Per-core utilization between two snapshots, or null when the core shapes
 * differ (hotplug): there is no valid previous reading then, and the next
 * pair lines up again.
 * @param {{ total: number, idle: number }[]} prevCores Earlier per-core snapshots
 * @param {{ total: number, idle: number }[]} curCores Later per-core snapshots
 * @returns {number[] | null}
 */
function perCoreUtilization(prevCores, curCores) {
    if (!Array.isArray(prevCores) || !Array.isArray(curCores)) {
        return null;
    }
    if (prevCores.length !== curCores.length) {
        return null;
    }
    const out = [];
    for (let i = 0; i < curCores.length; i++) {
        const percent = utilization(prevCores[i], curCores[i]);
        if (percent === null) {
            return null;
        }
        out.push(percent);
    }
    return out;
}

/**
 * Full-window transform of one snapshot against its predecessor.
 * @param {{ total: number, idle: number, perCore: object[] } | null} prev Earlier counters (null on first sight)
 * @param {{ total: number, idle: number, perCore: object[] }} cur Current counters
 * @returns {{ percent: number, perCore: number[] | null, cores: number } | null} Null when incomputable
 */
function transformCounters(prev, cur) {
    if (!prev || !cur) {
        return null;
    }
    const percent = utilization(prev, cur);
    if (percent === null) {
        return null;
    }
    const perCore = cur.perCore.length ? perCoreUtilization(prev.perCore, cur.perCore) : null;
    return { percent, perCore, cores: cur.perCore.length || 0 };
}

module.exports = { asCounters, utilization, perCoreUtilization, transformCounters };
