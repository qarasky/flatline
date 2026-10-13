const { MonitorType, operationTimeoutMs } = require("./monitor-type");
const { log, UP } = require("../../src/util");
const dayjs = require("dayjs");
const postgresConParse = require("pg-connection-string").parse;
const { Client } = require("pg");

class PostgresMonitorType extends MonitorType {
    name = "postgres";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        let startTime = dayjs().valueOf();

        let query = monitor.databaseQuery;
        // No query provided by user, use SELECT 1
        if (!query || (typeof query === "string" && query.trim() === "")) {
            query = "SELECT 1";
        }
        await this.postgresQuery(monitor.databaseConnectionString, query, operationTimeoutMs(monitor));

        heartbeat.msg = "";
        heartbeat.status = UP;
        heartbeat.ping = dayjs().valueOf() - startTime;
    }

    /**
     * Run a query on Postgres under an explicit deadline.
     *
     * The monitor timeout bounds the whole operation: the connection
     * handshake and the query both get it (pg enforces both), and the timer
     * below is the backstop for a server that accepts the connection and
     * then never answers. Before this, such a server left the check — and
     * with it the awaited monitor loop, beats and alerts — pending forever.
     *
     * The client is always closed, on success, error and timeout alike: a
     * timed-out check must not leak its connection.
     * @param {string} connectionString The database connection string
     * @param {string} query The query to validate the database with
     * @param {number} timeoutMs Deadline in milliseconds
     * @returns {Promise<(string[] | object[] | object)>} Response from
     * server
     */
    async postgresQuery(connectionString, query, timeoutMs = operationTimeoutMs({})) {
        return new Promise((resolve, reject) => {
            const config = postgresConParse(connectionString);

            // Fix #3868, which true/false is not parsed to boolean
            if (typeof config.ssl === "string") {
                config.ssl = config.ssl === "true";
            }

            if (config.password === "") {
                // See https://github.com/brianc/node-postgres/issues/1927
                reject(new Error("Password is undefined."));
                return;
            }

            config.connectionTimeoutMillis = timeoutMs;
            config.query_timeout = timeoutMs;

            const client = new Client(config);
            let settled = false;
            let timer = null;

            /**
             * Settle once, release the client, clear the backstop.
             * @param {Error|undefined} error Failure, if any
             * @param {*} result Query result
             * @returns {void}
             */
            const finish = (error, result) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                releaseClient(client);
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            };

            timer = setTimeout(
                () => finish(new Error(`Postgres connection/query timed out after ${Math.round(timeoutMs / 1000)}s`)),
                timeoutMs
            );

            client.on("error", (error) => {
                log.debug(this.name, "Error caught in the error event handler.");
                finish(error);
            });

            client.connect((err) => {
                if (err) {
                    finish(err);
                    return;
                }
                // Connected here
                try {
                    client.query(query, (queryError, res) => finish(queryError, res));
                } catch (e) {
                    finish(e);
                }
            });
        });
    }
}

/**
 * Close a client and guarantee its socket dies.
 *
 * `end()` is the graceful path; a server that never answers can leave the
 * socket half-open, so a short timer force-destroys the stream. Cleanup
 * must never throw into the check that is already settling.
 * @param {Client} client Connected or connecting pg client
 * @returns {void}
 */
function releaseClient(client) {
    try {
        client.end().catch(() => {});
    } catch {
        // Already closed.
    }

    const socketTimer = setTimeout(() => {
        try {
            const stream = client.connection?.stream;
            if (stream && typeof stream.destroy === "function" && !stream.destroyed) {
                stream.destroy();
            }
        } catch {
            // Best effort only.
        }
    }, 1000);
    socketTimer.unref?.();
}

module.exports = {
    PostgresMonitorType,
};
