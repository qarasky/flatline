/**
 * Adds `monitor_link`: which website monitors a server monitor hosts.
 *
 * A "server" in Flatline is a monitor that emits metrics (usually a `push`
 * monitor). This table records, per server, the website monitors shown as
 * status chips on its Superboard card. The linked target may be an ordinary
 * monitor or a `group` monitor: a group is expanded to its non-group
 * descendants when the links are read, so adding a whole group links every
 * website inside it, including ones added later.
 *
 * Cascade delete is correct for both columns: a link whose server or target
 * was removed is meaningless, so it goes with either. The pair is unique so
 * the same website cannot be linked twice.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.createTable("monitor_link", function (table) {
        table.increments("id").primary();
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table
            .integer("linked_monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.unique([ "monitor_id", "linked_monitor_id" ], "monitor_link_pair_idx");
        table.index("monitor_id", "monitor_link_monitor_idx");
    });
};

/**
 * Drops the `monitor_link` table.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.down = function (knex) {
    return knex.schema.dropTable("monitor_link");
};
