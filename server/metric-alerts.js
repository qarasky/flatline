const { log } = require("../src/util");
const { Notification } = require("./notification");
const Monitor = require("./model/monitor");

/**
 * Server-side metric threshold alerts.
 *
 * Alert-only by contract (SUPERBOARD-SPEC.md Phase 5): a breach never flips
 * a monitor's status or writes heartbeat rows. Evaluation reads the latest
 * cached sample — the values the server already derives — and a tiny state
 * machine decides when to speak:
 *
 * - debounce: the value must stay at or above the threshold for 60 seconds;
 *   a one-second spike never pages anyone.
 * - hysteresis: recovery is declared at threshold - 5 points, so values
 *   hovering at the boundary do not flap.
 * - cooldown: while still breached, at most one repeat per 30 minutes.
 * - a recovery message is sent only when an alert for that breach actually
 *   went out; fully suppressed episodes stay silent.
 *
 * State is in-memory and bounded: an agent or backend restart may re-send
 * one alert after the debounce. Thresholds are for live conditions; history
 * keeps the evidence. Evaluation uses receive time, not `sampledAt`, so a
 * backfilled backlog arriving compressed cannot replay old alert timelines.
 */

const DEBOUNCE_MS = 60_000;
const COOLDOWN_MS = 30 * 60_000;
const HYSTERESIS = 5;
const MAX_STATE = 512;

/**
 * Per-monitor state: one entry per metric.
 * `breachedSince` is when the current breach episode began, `alerted`
 * whether an alert went out for it, `lastNotified` the last alert send.
 */
const state = new Map();

/**
 * Drop alert state for one monitor (tests, monitor deletion).
 * @param {number} id Monitor id
 * @returns {void}
 */
function forgetMetricAlerts(id) {
    state.delete(Number(id));
}

/**
 * Clear all alert state (tests, shutdown).
 * @returns {void}
 */
function resetMetricAlerts() {
    state.clear();
}

/**
 * Extract the readings a threshold can apply to from one sample.
 * @param {object} metrics Decoded metrics payload
 * @returns {{cpu: ?number, ram: ?number, disk: ?number, diskMount: ?string}} Readings; null per metric when absent or invalid
 */
function readingsFrom(metrics) {
    const finite = (value) => (Number.isFinite(value) ? value : null);
    let disk = null;
    let diskMount = null;
    for (const mount of metrics?.disk ?? []) {
        const percent = finite(mount?.percent);
        if (percent !== null && (disk === null || percent > disk)) {
            disk = percent;
            diskMount = mount.mount ?? null;
        }
    }
    return {
        cpu: finite(metrics?.cpu?.percent),
        ram: finite(metrics?.mem?.percent),
        disk,
        diskMount,
    };
}

/**
 * Pure state-machine step for one metric. Mutates `metricState`, returns the
 * action to take, if any.
 *
 * Actions: `alert` (first alert or a cooldown repeat), `recover`, or null.
 * @param {object} metricState Mutable per-metric state
 * @param {?number} value Current reading, or null when absent
 * @param {number} threshold Configured threshold, 1-100
 * @param {number} now Current wall-clock ms
 * @returns {"alert"|"recover"|null} Action due
 */
function stepMetric(metricState, value, threshold, now) {
    if (value === null) {
        // No reading (agent omitted the metric): leave the episode alone
        // rather than inventing a recovery.
        return null;
    }

    const recoverAt = threshold - HYSTERESIS;
    if (value <= recoverAt) {
        const wasAlerted = metricState.alerted;
        metricState.breachedSince = null;
        metricState.alerted = false;
        return wasAlerted ? "recover" : null;
    }

    if (value < threshold) {
        // Hysteresis band: above recovery, below the alert line. The episode
        // stays open but stays silent — a repeat here would claim "88% ≥ 90%".
        // Recovery is only declared at threshold - HYSTERESIS.
        return null;
    }

    // At or above the threshold.
    if (metricState.breachedSince === null) {
        metricState.breachedSince = now;
        return null;
    }
    if (now - metricState.breachedSince < DEBOUNCE_MS) {
        return null;
    }
    if (!metricState.alerted) {
        return "alert";
    }
    return now - metricState.lastNotified >= COOLDOWN_MS ? "alert" : null;
}

/**
 * Fetch (or create) the mutable state slot for one metric of one monitor.
 * The map is bounded like the CPU peak tracker: oldest monitor evicted.
 * @param {number} monitorID Monitor id
 * @param {string} metric Metric key
 * @returns {object} Mutable per-metric state
 */
function metricStateFor(monitorID, metric) {
    let monitorState = state.get(monitorID);
    if (!monitorState) {
        monitorState = {};
        state.set(monitorID, monitorState);
        if (state.size > MAX_STATE) {
            state.delete(state.keys().next().value);
        }
    }
    if (!monitorState[metric]) {
        monitorState[metric] = { breachedSince: null, alerted: false, lastNotified: 0 };
    }
    return monitorState[metric];
}

/**
 * Format the human message for one action. `[name] [⚠️ Metric] CPU 94.2% ≥
 * threshold 90%` mirrors the heartbeat alerts' `[name] [🔴 Down]` shape.
 * @param {string} monitorName Display name
 * @param {string} metric Metric key
 * @param {?string} mount Disk mount, when relevant
 * @param {number} value Reading
 * @param {number} threshold Configured threshold
 * @param {"alert"|"recover"} action Action
 * @returns {string} Message
 */
function formatMetricMessage(monitorName, metric, mount, value, threshold, action) {
    const label = metric === "cpu" ? "CPU" : metric === "ram" ? "RAM" : "Disk";
    const target = metric === "disk" && mount ? `Disk ${mount}` : label;
    const rounded = Math.round(value * 10) / 10;
    if (action === "recover") {
        return `[${monitorName}] [✅ Metric] ${target} recovered: ${rounded}% (threshold ${threshold}%)`;
    }
    return `[${monitorName}] [⚠️ Metric] ${target} ${rounded}% ≥ threshold ${threshold}%`;
}

/**
 * Evaluate one monitor's latest sample against its thresholds.
 *
 * Called fire-and-forget from the push route: any failure is logged and
 * swallowed, because a broken alert must never fail an ingest. A monitor
 * with no thresholds costs one parse.
 * @param {Bean} monitor Monitor bean (must carry the threshold columns)
 * @returns {Promise<void>}
 */
async function evaluateMetricAlerts(monitor) {
    const thresholds = {
        cpu: monitor.metric_cpu_threshold ?? null,
        ram: monitor.metric_ram_threshold ?? null,
        disk: monitor.metric_disk_threshold ?? null,
    };
    if (thresholds.cpu === null && thresholds.ram === null && thresholds.disk === null) {
        return;
    }

    // Imported lazily to keep the require graph flat: monitor-metrics does
    // not import this module, so there is no cycle, but tests mock the cache.
    const { getLatestMetrics } = require("./monitor-metrics");
    const sample = getLatestMetrics(monitor.id);
    if (!sample) {
        return;
    }

    const now = Date.now();
    const readings = readingsFrom(sample.metrics);
    const monitorID = Number(monitor.id);

    for (const metric of [ "cpu", "ram", "disk" ]) {
        const threshold = thresholds[metric];
        if (threshold === null) {
            continue;
        }
        const metricState = metricStateFor(monitorID, metric);
        const action = stepMetric(metricState, readings[metric], threshold, now);
        if (!action) {
            continue;
        }

        // Maintenance suppresses delivery, not tracking: the episode stays
        // recorded and speaks once the window closes.
        if (await Monitor.isUnderMaintenance(monitorID)) {
            continue;
        }

        if (action === "alert") {
            metricState.alerted = true;
            metricState.lastNotified = now;
        }

        const message = formatMetricMessage(monitor.name, metric, readings.diskMount, readings[metric], threshold, action);
        await sendMetricNotification(monitor, message, {
            metric,
            action,
            value: readings[metric],
            threshold,
            mount: readings.diskMount,
        });
    }
}

/**
 * Deliver one alert message through the monitor's linked notifications,
 * mirroring Monitor.sendNotification's shape without touching heartbeat
 * semantics. Failures per provider are logged, never thrown upward.
 * @param {Bean} monitor Monitor bean
 * @param {string} message Preformatted message
 * @param {object} detail Metric detail for template context
 * @returns {Promise<void>}
 */
async function sendMetricNotification(monitor, message, detail) {
    const notificationList = await Monitor.getNotificationList(monitor);
    if (!notificationList.length) {
        log.debug("metric-alerts", `[${monitor.name}] No notifications linked; ${detail.metric} ${detail.action} recorded only`);
        return;
    }

    // A heartbeat-shaped marker so Telegram templates can label the event
    // instead of guessing "Test" (see notification-provider.renderTemplate).
    const heartbeatJSON = {
        metricAlert: true,
        msg: message,
        time: new Date().toISOString(),
        ...detail,
    };
    const monitorJSON = { id: monitor.id, name: monitor.name, active: monitor.active };

    for (const notification of notificationList) {
        try {
            await Notification.send(JSON.parse(notification.config), message, monitorJSON, heartbeatJSON);
        } catch (e) {
            log.error("metric-alerts", `Cannot send metric alert to ${notification.name}: ${e.message}`);
        }
    }
}

module.exports = {
    evaluateMetricAlerts,
    readingsFrom,
    stepMetric,
    formatMetricMessage,
    forgetMetricAlerts,
    resetMetricAlerts,
    DEBOUNCE_MS,
    COOLDOWN_MS,
    HYSTERESIS,
};
