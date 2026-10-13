/**
 * Adds `monitor_metric_rollup_state`: small durable key/value state for the
 * hourly rollup.
 *
 * The rollup needs one piece of durable state: the repair sweep's cursor, the
 * hour up to which the bounded reconciliation has verified coverage. Without
 * it, every run had to compare the whole raw retention window to find the
 * handful of hours that need work; with it, normal runs process the dirty
 * hours plus one bounded window, and the whole window is still swept within a
 * cycle.
 *
 * A key/value table rather than a column on an existing table: the rollup
 * owns it, and future maintenance state (a second cursor, a schema marker)
 * fits without another migration.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.createTable("monitor_metric_rollup_state", function (table) {
        table.increments("id").primary();
        table.string("name", 64).notNullable().unique();
        table.string("value", 128).notNullable();
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("monitor_metric_rollup_state");
};
