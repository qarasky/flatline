/**
 * Server-side rate derivation for cumulative byte counters.
 *
 * Same contract as CPU: agents forward raw cumulative snapshots (network
 * interfaces, whole disks) and the server owns the window. Rates are derived
 * between consecutive pushes and attached to the live sample as
 * `netRate`/`diskIoRate`; archived rows keep the raw counters, which are
 * lossless — history consumers can diff consecutive stored rows themselves.
 *
 * Every function is total: missing data, counter resets, non-positive or
 * absurdly long windows all yield null, and the board simply shows nothing.
 * A gap (agent restart, outage) must never be averaged into a fake rate.
 */

/** Longest window a rate may describe; beyond it, gaps win and the rate is omitted. */
const MAX_WINDOW_MS = 5 * 60_000;

/**
 * Virtual interface prefixes excluded when summing card throughput.
 * Container and bridge traffic already traverses the physical parent, so
 * summing both would double count. If a host only has virtual interfaces
 * (rare), the fallback sums everything rather than showing zero.
 */
const VIRTUAL_IFACE = /^(veth|docker|br-|virbr|vnet|tap|tun|wg)/;

/**
 * Normalise the `net` list of one payload into a map of interface counters.
 * @param {object} metrics Decoded metrics payload
 * @returns {?Map<string, {rx: number, tx: number}>} Counters, or null when absent/invalid
 */
function netSnapshot(metrics) {
    const list = metrics?.net;
    if (!Array.isArray(list)) {
        return null;
    }
    const map = new Map();
    for (const entry of list) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const iface = typeof entry.iface === "string" && entry.iface !== "" ? entry.iface : null;
        const rx = Number(entry.rxBytes);
        const tx = Number(entry.txBytes);
        if (iface && Number.isFinite(rx) && Number.isFinite(tx) && rx >= 0 && tx >= 0) {
            map.set(iface, { rx, tx });
        }
    }
    return map.size ? map : null;
}

/**
 * Normalise the `diskIo` list of one payload into a map of disk counters.
 * @param {object} metrics Decoded metrics payload
 * @returns {?Map<string, {read: number, write: number}>} Counters, or null when absent/invalid
 */
function diskSnapshot(metrics) {
    const list = metrics?.diskIo;
    if (!Array.isArray(list)) {
        return null;
    }
    const map = new Map();
    for (const entry of list) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const device = typeof entry.device === "string" && entry.device !== "" ? entry.device : null;
        const read = Number(entry.readBytes);
        const write = Number(entry.writeBytes);
        if (device && Number.isFinite(read) && Number.isFinite(write) && read >= 0 && write >= 0) {
            map.set(device, { read, write });
        }
    }
    return map.size ? map : null;
}

/**
 * Sum per-key deltas over the counters both snapshots share.
 * @param {Map<string, object>} prev Earlier snapshot
 * @param {Map<string, object>} cur Later snapshot
 * @param {string[]} fields Field names to sum
 * @param {?function(string): boolean} include Key filter, or null for all
 * @returns {?object} Totals per field, or null when nothing matched or a counter decreased
 */
function sumDeltas(prev, cur, fields, include) {
    let totals = null;
    for (const [ key, after ] of cur) {
        if (include && !include(key)) {
            continue;
        }
        const before = prev.get(key);
        if (!before) {
            // Interface/device appeared mid-window: no valid delta yet.
            continue;
        }
        totals = totals ?? {};
        for (const field of fields) {
            if (after[field] < before[field]) {
                // Counter reset (reboot, device re-added): never a negative rate.
                return null;
            }
            totals[field] = (totals[field] ?? 0) + (after[field] - before[field]);
        }
    }
    return totals;
}

/**
 * Network throughput between two snapshots, non-virtual interfaces first.
 * @param {?Map<string, object>} prev Earlier counters
 * @param {?Map<string, object>} cur Later counters
 * @param {number} dtMs Window length in milliseconds
 * @returns {?{rxBytesPerSec: number, txBytesPerSec: number, windowSeconds: number}} Rate, or null
 */
function netRates(prev, cur, dtMs) {
    if (!prev || !cur || !(dtMs > 0) || dtMs > MAX_WINDOW_MS) {
        return null;
    }
    let totals = sumDeltas(prev, cur, [ "rx", "tx" ], (key) => !VIRTUAL_IFACE.test(key));
    if (!totals) {
        totals = sumDeltas(prev, cur, [ "rx", "tx" ], null);
    }
    if (!totals) {
        return null;
    }
    const seconds = dtMs / 1000;
    return {
        rxBytesPerSec: totals.rx / seconds,
        txBytesPerSec: totals.tx / seconds,
        windowSeconds: seconds,
    };
}

/**
 * Disk throughput between two snapshots, summed over whole disks.
 * @param {?Map<string, object>} prev Earlier counters
 * @param {?Map<string, object>} cur Later counters
 * @param {number} dtMs Window length in milliseconds
 * @returns {?{readBytesPerSec: number, writeBytesPerSec: number, windowSeconds: number}} Rate, or null
 */
function diskRates(prev, cur, dtMs) {
    if (!prev || !cur || !(dtMs > 0) || dtMs > MAX_WINDOW_MS) {
        return null;
    }
    const totals = sumDeltas(prev, cur, [ "read", "write" ], null);
    if (!totals) {
        return null;
    }
    const seconds = dtMs / 1000;
    return {
        readBytesPerSec: totals.read / seconds,
        writeBytesPerSec: totals.write / seconds,
        windowSeconds: seconds,
    };
}

module.exports = {
    netSnapshot,
    diskSnapshot,
    netRates,
    diskRates,
    MAX_WINDOW_MS,
};
