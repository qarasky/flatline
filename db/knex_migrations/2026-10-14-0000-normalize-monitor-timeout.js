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
 * `Monitor.ensureTimeout()`. The calculation runs in JavaScript rather than
 * SQL: `interval` is a reserved word in MySQL/MariaDB and integer casts
 * differ per dialect, and the affected row count is normally zero or small.
 * @param {object} knex Knex instance
 * @returns {Promise<void>} Resolves when every row is normalized
 */
exports.up = async function (knex) {
    const rows = await knex("monitor")
        .select("id", "interval", "timeout")
        .where("timeout", "<=", 0)
        .orWhereNull("timeout");

    for (const row of rows) {
        const interval = Number(row.interval);
        const timeout = Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.floor(interval * 0.8)) : 48;
        await knex("monitor").where("id", row.id).update({ timeout });
    }
};

/**
 * Nothing to undo: the previous values (0/NULL) carried no information, and
 * restoring them would restore the bug.
 * @returns {Promise<void>} Resolves immediately
 */
exports.down = function () {
    return Promise.resolve();
};
