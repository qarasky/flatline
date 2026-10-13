/**
 * Rollup coverage groundwork: dirty-hour markers and a fleet-wide time index.
 *
 * `monitor_metric_rollup_dirty` records the hours whose bucket may have
 * become stale: a buffered agent can deliver a sample into an hour that a
 * previous rollup run already folded, and the marker makes the next run
 * re-fold that hour instead of trusting its age. The unique key makes the
 * ingest-side write an idempotent upsert, and the cascade keeps markers for
 * deleted monitors from lingering.
 *
 * `monitor_metric_time_idx` indexes the raw table by time first. The
 * existing `(monitor_id, time)` index serves per-monitor history reads, but
 * the rollup's coverage scan and the raw prune filter fleet-wide on time
 * alone; without a time index they degrade to full-table scans that read
 * every payload.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema
        .createTable("monitor_metric_rollup_dirty", function (table) {
            table.increments("id").primary();
            table
                .integer("monitor_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("monitor")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");
            // Hour bucket start, UTC, stored like every other metric timestamp.
            table.dateTime("hour").notNullable();
            table.unique([ "monitor_id", "hour" ], "monitor_metric_rollup_dirty_pair");
        })
        .then(() =>
            knex.schema.alterTable("monitor_metric", function (table) {
                table.index([ "time", "monitor_id" ], "monitor_metric_time_idx");
            })
        );
};

exports.down = function (knex) {
    return knex.schema
        .dropTable("monitor_metric_rollup_dirty")
        .then(() =>
            knex.schema.alterTable("monitor_metric", function (table) {
                table.dropIndex([ "time", "monitor_id" ], "monitor_metric_time_idx");
            })
        );
};
