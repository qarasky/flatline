/**
 * Adds `monitor.provider`: the hosting provider a box runs on.
 *
 * A free-form string (normally a domain, e.g. "ps.kz", "hetzner.com") read by
 * the dashboard to put the provider's logo on a Superboard card. The server
 * deliberately stores only the string and never validates it against a list:
 * the provider catalog lives in the frontend, so a new provider needs no
 * migration, and a future provider monitor type can reuse the same column
 * without changing the shape. NULL means "not set" — existing monitors keep
 * rendering exactly as before.
 * @param {object} knex Knex instance
 * @returns {Promise<object>} Migration result
 */
exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.string("provider", 128).nullable();
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("provider");
    });
};
