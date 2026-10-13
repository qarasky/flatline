/**
 * Fallback deadline for one check when a monitor has no usable timeout.
 * @type {number}
 */
const DEFAULT_TIMEOUT_MS = 48_000;

/**
 * Deadline for one check, in milliseconds.
 *
 * `monitor.timeout` is stored in seconds. Zero or missing (legacy rows the
 * runtime never normalized) falls back to a bounded default instead of
 * meaning "no limit": a server that accepts a connection and then stops
 * answering must not hold the monitor's loop open forever.
 * @param {{timeout?: number}} monitor Monitor being checked
 * @returns {number} Deadline in milliseconds
 */
function operationTimeoutMs(monitor) {
    const seconds = Number(monitor?.timeout);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TIMEOUT_MS;
}

class MonitorType {
    name = undefined;

    /**
     * Whether or not this type supports monitor conditions. Controls UI visibility in monitor form.
     * @type {boolean}
     */
    supportsConditions = false;

    /**
     * Variables supported by this type. e.g. an HTTP type could have a "response_code" variable to test against.
     * This property controls the choices displayed in the monitor edit form.
     * @type {import("../monitor-conditions/variables").ConditionVariable[]}
     */
    conditionVariables = [];

    /**
     * Allows setting any custom status to heartbeat, other than UP.
     * @type {boolean}
     */
    allowCustomStatus = false;

    /**
     * Run the monitoring check on the given monitor
     *
     * Successful cases: Should update heartbeat.status to "up" and set response time.
     * Failure cases: Throw an error with a descriptive message.
     * @param {Monitor} monitor Monitor to check
     * @param {Heartbeat} heartbeat Monitor heartbeat to update
     * @param {UptimeKumaServer} server Flatline server
     * @returns {Promise<void>}
     */
    async check(monitor, heartbeat, server) {
        throw new Error("You need to override check()");
    }
}

module.exports = {
    MonitorType,
    DEFAULT_TIMEOUT_MS,
    operationTimeoutMs,
};
