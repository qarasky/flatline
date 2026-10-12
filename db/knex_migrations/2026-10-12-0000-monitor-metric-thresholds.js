/**
 * Adds per-monitor metric threshold columns for server-side alerts.
 *
 * Three nullable integers, 1-100, one per metric. NULL means disabled: the
 * server only evaluates what an operator opted into, and an upgrade adds no
 * alerts to anyone's fleet. Disk compares the fullest reported mount.
 *
 * Alert-only by contract (see SUPERBOARD-SPEC.md Phase 5): no status flips,
 * no heartbeat rows. Evaluation lives in server/metric-alerts.js and reads
 * these columns directly.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.integer("metric_cpu_threshold").nullable();
        table.integer("metric_ram_threshold").nullable();
        table.integer("metric_disk_threshold").nullable();
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("metric_cpu_threshold");
        table.dropColumn("metric_ram_threshold");
        table.dropColumn("metric_disk_threshold");
    });
};
