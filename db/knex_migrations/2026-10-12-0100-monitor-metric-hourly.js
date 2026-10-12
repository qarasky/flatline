/**
 * Adds `monitor_metric_hourly`: the long tier of Superboard metrics history.
 *
 * Raw samples (`monitor_metric`) keep their 30-day retention at ~30s
 * resolution. This table holds one rollup per monitor per hour — min, max
 * and average per metric — kept for two years, so the history API can answer
 * long-range questions without pretending it still has raw peaks.
 *
 * The (monitor_id, time) unique key is the idempotency anchor: the rollup
 * job upserts buckets, so a crash mid-backfill or a re-run cannot duplicate
 * or corrupt an hour.
 *
 * Cascade delete is correct here, same as monitor_metric: rollups for a
 * deleted monitor are meaningless.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.createTable("monitor_metric_hourly", function (table) {
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
        table.dateTime("time").notNullable();

        // Per metric: true extremes plus the hour average. NULL means the
        // metric was absent in that hour (no GPU, invalid readings), never
        // zero.
        for (const field of [ "cpu", "ram", "gpu", "vram" ]) {
            table.float(`${field}_min`).nullable();
            table.float(`${field}_max`).nullable();
            table.float(`${field}_avg`).nullable();
        }

        // Raw readings that contributed; the honest "sample count" for the
        // long tier, where one row stands for many 30s samples.
        table.integer("samples").notNullable().defaultTo(0);

        table.unique([ "monitor_id", "time" ], "monitor_metric_hourly_bucket");
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("monitor_metric_hourly");
};
