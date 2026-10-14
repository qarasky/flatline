/**
 * Shared monitor create/update/delete logic.
 *
 * Both the Socket.IO handlers in server.js and REST API v1 go through this
 * module, so the two surfaces cannot drift apart.
 *
 * Flatline is a shared instance: every logged-in user sees and edits the same
 * monitors, so these functions do not filter on `user_id`. That column is
 * still written on create, purely to record who added a monitor.
 *
 * `createMonitor` is the one exception and takes a `userID`, because it records
 * the creator.
 */
const { R } = require("redbean-node");
const { log } = require("../src/util");
const Monitor = require("./model/monitor");
const { UptimeKumaServer } = require("./uptime-kuma-server");
const { publish } = require("./live-updates");

/**
 * Frontend-only properties that must never reach the database.
 * @type {string[]}
 */
const FRONTEND_ONLY_PROPERTIES = [
    "humanReadableInterval",
    "globalpingdnsresolvetypeoptions",
    "responsecheck",
];

/**
 * camelCase frontend property -> snake_case database column.
 *
 * The Vue form uses camelCase for a few fields that are stored snake_case.
 * Both transports must apply the same mapping or the value is silently lost.
 * @type {{[key: string]: string}}
 */
const CAMEL_TO_SNAKE_COLUMNS = {
    retryOnlyOnStatusCodeFailure: "retry_only_on_status_code_failure",
    saveResponse: "save_response",
    saveErrorResponse: "save_error_response",
    responseMaxLength: "response_max_length",
    expectedTlsAlert: "expected_tls_alert",
    ntpStratumThreshold: "ntp_stratum_threshold",
    ntpTimeOffsetThreshold: "ntp_time_offset_threshold",
    ntpRootDispersionThreshold: "ntp_root_dispersion_threshold",
    metricCpuThreshold: "metric_cpu_threshold",
    metricRamThreshold: "metric_ram_threshold",
    metricDiskThreshold: "metric_disk_threshold",
};

/**
 * Fields that are JSON-encoded before being stored.
 *
 * The Vue form sends arrays/objects; the database wants text.
 * @type {string[]}
 */
const JSON_SERIALISED_FIELDS = [
    "kafkaProducerBrokers",
    "kafkaProducerSaslOptions",
    "conditions",
    "rabbitmqNodes",
    "accepted_statuscodes_json",
];

/**
 * Metric threshold columns (snake_case), validated as 1-100 integers.
 * @type {string[]}
 */
const METRIC_THRESHOLD_COLUMNS = [
    "metric_cpu_threshold",
    "metric_ram_threshold",
    "metric_disk_threshold",
];

/**
 * Load a monitor by id.
 *
 * Flatline is a shared instance: there are no roles and `user_id` is recorded
 * only as "who created this" for the audit trail. It is deliberately not
 * filtered on, so every user sees the same set.
 * @param {number} monitorID Monitor to load
 * @returns {Promise<?Bean>} The monitor bean, or null if it does not exist
 */
async function loadMonitor(monitorID) {
    return await R.findOne("monitor", " id = ? ", [ monitorID ]);
}

/**
 * Replace a monitor's notification links.
 * @param {number} monitorID Monitor to update
 * @param {{[key: string]: boolean}} notificationIDList Map of notification id -> enabled
 * @returns {Promise<void>}
 */
async function updateMonitorNotification(monitorID, notificationIDList) {
    await R.exec("DELETE FROM monitor_notification WHERE monitor_id = ? ", [ monitorID ]);

    for (const notificationID in notificationIDList) {
        if (notificationIDList[notificationID]) {
            const relation = R.dispense("monitor_notification");
            relation.monitor_id = monitorID;
            relation.notification_id = notificationID;
            await R.store(relation);
        }
    }
}

/**
 * Normalise a raw monitor payload into values ready for the database.
 *
 * Shared by create and update so both handle JSON fields, camelCase columns
 * and frontend-only keys identically.
 * @param {object} payload Raw monitor object from a form or API body
 * @returns {object} Cleaned payload, safe to copy onto a bean
 * @throws {Error} When accepted status codes are not all strings
 */
function normaliseMonitorPayload(payload) {
    const out = { ...payload };

    // Strip frontend-only keys.
    for (const prop of FRONTEND_ONLY_PROPERTIES) {
        delete out[prop];
    }

    // accepted_statuscodes arrives as an array; store it as JSON text. The
    // upstream UI required every entry to be a string, so keep that check
    // rather than silently storing numbers.
    if (Array.isArray(out.accepted_statuscodes)) {
        if (!out.accepted_statuscodes.every((code) => typeof code === "string")) {
            throw new Error("Accepted status codes are not all strings");
        }
        out.accepted_statuscodes_json = JSON.stringify(out.accepted_statuscodes);
        delete out.accepted_statuscodes;
    } else if (Array.isArray(out.accepted_statuscodes_json)) {
        out.accepted_statuscodes_json = JSON.stringify(out.accepted_statuscodes_json);
    }

    // Fields the Vue form sends as structured values.
    for (const field of JSON_SERIALISED_FIELDS) {
        if (field === "accepted_statuscodes_json") {
            continue;
        }
        if (out[field] !== undefined && out[field] !== null && typeof out[field] !== "string") {
            out[field] = JSON.stringify(out[field]);
        }
    }

    // Explicit camelCase -> column mappings.
    for (const [ from, to ] of Object.entries(CAMEL_TO_SNAKE_COLUMNS)) {
        if (out[from] !== undefined) {
            out[to] = out[from];
            delete out[from];
        }
    }

    // port is stored as an integer; blank input means "unset".
    if (out.port !== undefined) {
        const parsed = parseInt(out.port);
        out.port = isNaN(parsed) ? null : parsed;
    }

    // Provider is a display id (usually a domain): lowercase, trimmed, and
    // blank means "unset" rather than an empty string that would render a
    // broken logo lookup.
    if (out.provider !== undefined) {
        const provider = typeof out.provider === "string" ? out.provider.trim().toLowerCase() : "";
        out.provider = provider === "" ? null : provider.slice(0, 128);
    }

    // Metric thresholds are integers 1-100; anything else (blank, zero,
    // out of range, garbage) stores as NULL = disabled. An operator's typo
    // must disable the alert, never fire it at the wrong bound.
    for (const key of METRIC_THRESHOLD_COLUMNS) {
        if (out[key] !== undefined) {
            const parsed = parseInt(out[key]);
            out[key] = Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
        }
    }

    if (out.proxyId !== undefined) {
        out.proxyId = Number.isInteger(out.proxyId) ? out.proxyId : null;
    }

    if (out.retry_only_on_status_code_failure !== undefined) {
        out.retry_only_on_status_code_failure = Boolean(out.retry_only_on_status_code_failure);
    }

    return out;
}

/**
 * Apply a validated interval policy that matches what the UI does.
 *
 * The schema defaults retry_interval to 0, but Monitor.validate() rejects
 * anything below 1, and older rows can hold 0. The Vue form repairs this on
 * submit; REST callers need the same repair or they get an opaque error.
 * @param {object} payload Normalised payload, mutated in place
 * @returns {object} The same payload
 */
function applyIntervalDefaults(payload) {
    if (!payload.interval) {
        payload.interval = 20;
    }

    if (!payload.retryInterval) {
        payload.retryInterval = payload.interval;
    }

    if (!payload.timeout) {
        payload.timeout = Math.floor((payload.interval * 8) / 10);
    }

    return payload;
}

/**
 * Create a monitor.
 * @param {string} userID Creator, recorded for the audit trail only
 * @param {object} payload Monitor fields
 * @param {object} options Behaviour switches
 * @param {boolean} options.start Run the check loop immediately when active
 * @param {{[key: string]: boolean}} options.notificationIDList Notification links
 * @returns {Promise<Bean>} The stored monitor
 */
async function createMonitor(userID, payload, options = {}) {
    const { start = true, notificationIDList = null } = options;

    const cleaned = applyIntervalDefaults(normaliseMonitorPayload(payload));

    const bean = R.dispense("monitor");
    bean.import(cleaned);

    // Recorded as the creator, never taken from the payload, and never used to
    // filter: this is a shared instance.
    bean.user_id = userID;

    if (cleaned.retry_only_on_status_code_failure !== undefined) {
        bean.retry_only_on_status_code_failure = Boolean(cleaned.retry_only_on_status_code_failure);
    }

    bean.validate();

    await R.store(bean);

    if (notificationIDList) {
        await updateMonitorNotification(bean.id, notificationIDList);
    }

    log.info("monitor", `Added Monitor: ${bean.id} Created by User ID: ${userID}`);
    publish({ type: "invalidate" });

    if (start && bean.active !== false) {
        await startMonitor(bean.id);
    }

    return bean;
}

/**
 * Update a monitor.
 *
 * Only keys present in the payload are touched, so a partial REST PATCH does
 * not blank out fields it did not mention. The Vue form always sends the full
 * object, which behaves the same way.
 * @param {number} monitorID Monitor to update
 * @param {object} payload Monitor fields to change
 * @param {object} options Behaviour switches
 * @param {{[key: string]: boolean}} options.notificationIDList Notification links
 * @returns {Promise<Bean>} The stored monitor
 */
async function updateMonitor(monitorID, payload, options = {}) {
    const { notificationIDList = null } = options;

    const bean = await loadMonitor(monitorID);

    if (!bean) {
        throw new Error("No such monitor.");
    }

    const cleaned = normaliseMonitorPayload(payload);

    // A parent pointing at itself, or at one of its own descendants, would build
    // a cycle that makes the group tree impossible to walk.
    if (cleaned.parent !== undefined && cleaned.parent !== null) {
        if (cleaned.parent === monitorID) {
            throw new Error("Invalid Monitor Group");
        }

        const childIDs = await Monitor.getAllChildrenIDs(monitorID);
        if (childIDs.includes(cleaned.parent)) {
            throw new Error("Invalid Monitor Group");
        }
    }

    // Changing a group into a non-group must unlink its children, or they
    // dangle pointing at a type that can no longer hold them.
    let unlinkChildren = false;
    if (bean.type === "group" && cleaned.type !== undefined && cleaned.type !== "group") {
        unlinkChildren = true;
    }

    for (const [ key, value ] of Object.entries(cleaned)) {
        // Never let a payload reassign the recorded creator or the primary key.
        if (key === "user_id" || key === "id") {
            continue;
        }
        bean[key] = value;
    }

    // Partial updates still need a legal interval/retry combination, so apply
    // the same repair the UI performs to the merged values.
    if (cleaned.interval !== undefined || cleaned.retryInterval !== undefined || cleaned.timeout !== undefined) {
        applyIntervalDefaults({
            interval: bean.interval,
            retryInterval: bean.retryInterval,
            timeout: bean.timeout,
        });
        bean.retryInterval = bean.retryInterval || bean.interval;
        bean.timeout = bean.timeout || Math.floor((bean.interval * 8) / 10);
    }

    bean.validate();

    await R.store(bean);

    if (unlinkChildren) {
        await Monitor.unlinkAllChildren(monitorID);
    }

    if (notificationIDList) {
        await updateMonitorNotification(bean.id, notificationIDList);
    }

    log.info("monitor", `Edited Monitor: ${bean.id}`);
    publish({ type: "invalidate" });

    // Pick up new config immediately; otherwise the old loop keeps running
    // with stale settings until the next restart.
    if (await Monitor.isActive(bean.id, bean.active)) {
        await startMonitor(bean.id);
    }

    return bean;
}

/**
 * Delete a monitor, optionally recursing into group children.
 * @param {number} monitorID Monitor to delete
 * @param {boolean} deleteChildren For groups, also delete descendants
 * @returns {Promise<number[]>} IDs of every monitor removed
 */
async function deleteMonitor(monitorID, deleteChildren = false) {
    const monitor = await loadMonitor(monitorID);
    const deleted = [];

    if (monitor && monitor.type === "group") {
        const children = await Monitor.getChildren(monitorID);

        if (deleteChildren) {
            if (children && children.length > 0) {
                for (const child of children) {
                    deleted.push(...await deleteMonitor(child.id, deleteChildren));
                }
            }
        } else {
            // Keep the children, just detach them from the group.
            await Monitor.unlinkAllChildren(monitorID);
        }
    }

    await Monitor.deleteMonitor(monitorID);
    require("./monitor-metrics").forgetMetrics(monitorID);
    publish({ type: "invalidate" });
    deleted.push(monitorID);

    log.info("manage", `Delete Monitor: ${monitorID}`);

    return deleted;
}

/**
 * Start (or restart) a monitor's check loop and mark it active.
 * @param {number} monitorID Monitor to start
 * @returns {Promise<Bean>} The monitor
 */
async function startMonitor(monitorID) {
    const monitor = await loadMonitor(monitorID);

    if (!monitor) {
        throw new Error("No such monitor.");
    }

    await R.exec("UPDATE monitor SET active = 1 WHERE id = ? ", [ monitorID ]);
    publish({ type: "invalidate" });

    const server = UptimeKumaServer.getInstance();
    if (monitor.id in server.monitorList) {
        await server.monitorList[monitor.id].stop();
    }

    server.monitorList[monitor.id] = monitor;
    await monitor.start();

    return monitor;
}

/**
 * Restart a monitor's check loop.
 * @param {number} monitorID Monitor to restart
 * @returns {Promise<Bean>} The monitor
 */
async function restartMonitor(monitorID) {
    return await startMonitor(monitorID);
}

/**
 * Pause a monitor and stop its check loop.
 * @param {number} monitorID Monitor to pause
 * @returns {Promise<void>}
 */
async function pauseMonitor(monitorID) {
    await R.exec("UPDATE monitor SET active = 0 WHERE id = ? ", [ monitorID ]);
    publish({ type: "invalidate" });

    const server = UptimeKumaServer.getInstance();
    if (monitorID in server.monitorList) {
        await server.monitorList[monitorID].stop();
        server.monitorList[monitorID].active = 0;
    }
}

module.exports = {
    createMonitor,
    updateMonitor,
    deleteMonitor,
    startMonitor,
    restartMonitor,
    pauseMonitor,
    loadMonitor,
    updateMonitorNotification,
    normaliseMonitorPayload,
    applyIntervalDefaults,
};
