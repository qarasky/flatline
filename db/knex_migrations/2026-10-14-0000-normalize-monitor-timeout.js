/**
 * Normalizes legacy zero-timeout monitors.
 *
 * Rows created before the timeout column was meaningful can store 0 (or
 * NULL). The Node runtime patches such a monitor to 80% of its interval —
 * in seconds — but only in memory, and only when its check loop runs; the
 * stored value stays wrong for every other reader (the API, the Rust
 * backend's importer, the dashboard). Normalize them once.
 *
 * The value is 80% of the interval in seconds, matching
 * `monitor-service.js` (`Math.floor(interval * 8 / 10)`) and
 * `Monitor.ensureTimeout()`.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex("monitor")
        .where("timeout", "<=", 0)
        .orWhereNull("timeout")
        .update({ timeout: knex.raw("CAST(interval * 8 / 10 AS INTEGER)") });
};

/**
 * Nothing to undo: the previous values (0/NULL) carried no information, and
 * restoring them would restore the bug.
 * @returns {Promise<void>} Resolves immediately
 */
exports.down = function () {
    return Promise.resolve();
};
