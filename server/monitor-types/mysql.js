const { MonitorType, operationTimeoutMs } = require("./monitor-type");
const { UP } = require("../../src/util");
const dayjs = require("dayjs");
const mysql = require("mysql2");
const { ConditionVariable } = require("../monitor-conditions/variables");
const { defaultStringOperators } = require("../monitor-conditions/operators");
const { ConditionExpressionGroup } = require("../monitor-conditions/expression");
const { evaluateExpressionGroup } = require("../monitor-conditions/evaluator");

class MysqlMonitorType extends MonitorType {
    name = "mysql";

    supportsConditions = true;
    conditionVariables = [new ConditionVariable("result", defaultStringOperators)];

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        let query = monitor.databaseQuery;
        if (!query || (typeof query === "string" && query.trim() === "")) {
            query = "SELECT 1";
        }

        // Use `radius_password` as `password` field for backwards compatibility
        // TODO: rename `radius_password` to `password` later for general use
        const password = monitor.radiusPassword;

        const conditions = monitor.conditions ? ConditionExpressionGroup.fromMonitor(monitor) : null;
        const hasConditions = conditions && conditions.children && conditions.children.length > 0;

        const startTime = dayjs().valueOf();
        const timeoutMs = operationTimeoutMs(monitor);
        try {
            if (hasConditions) {
                // When conditions are enabled, expect a single value result
                const result = await this.mysqlQuerySingleValue(monitor.databaseConnectionString, query, password, timeoutMs);
                heartbeat.ping = dayjs().valueOf() - startTime;

                const conditionsResult = evaluateExpressionGroup(conditions, { result: String(result) });

                if (!conditionsResult) {
                    throw new Error(`Query result did not meet the specified conditions (${result})`);
                }

                heartbeat.status = UP;
                heartbeat.msg = "Query did meet specified conditions";
            } else {
                // Backwards compatible: just check connection and return row count
                const result = await this.mysqlQuery(monitor.databaseConnectionString, query, password, timeoutMs);
                heartbeat.ping = dayjs().valueOf() - startTime;
                heartbeat.status = UP;
                heartbeat.msg = result;
            }
        } catch (error) {
            heartbeat.ping = dayjs().valueOf() - startTime;
            // Re-throw condition errors as-is, wrap database errors
            if (error.message.includes("did not meet the specified conditions")) {
                throw error;
            }
            throw new Error(`Database connection/query failed: ${error.message}`);
        }
    }

    /**
     * Run a query on MySQL/MariaDB (backwards compatible - returns row count).
     *
     * The monitor timeout bounds the connection handshake and the query
     * itself; a watchdog destroys the connection on expiry. Before this, a
     * server that accepted the connection and never answered left the check
     * pending forever, which stops the monitor loop (no beats, no alerts).
     * @param {string} connectionString The database connection string
     * @param {string} query The query to execute
     * @param {string} password Optional password override
     * @param {number} timeoutMs Deadline for connecting and querying
     * @returns {Promise<string>} Row count message
     */
    mysqlQuery(connectionString, query, password = undefined, timeoutMs = operationTimeoutMs({})) {
        return runMysqlQuery(connectionString, password, query, timeoutMs, (res) => {
            if (Array.isArray(res)) {
                return "Rows: " + res.length;
            }
            return "No Error, but the result is not an array. Type: " + typeof res;
        });
    }

    /**
     * Run a query on MySQL/MariaDB expecting a single value result.
     * @param {string} connectionString The database connection string
     * @param {string} query The query to execute
     * @param {string} password Optional password override
     * @param {number} timeoutMs Deadline for connecting and querying
     * @returns {Promise<any>} Single value from the first column of the first row
     */
    mysqlQuerySingleValue(connectionString, query, password = undefined, timeoutMs = operationTimeoutMs({})) {
        return runMysqlQuery(connectionString, password, query, timeoutMs, (res) => {

            // Check if we have results
            if (!Array.isArray(res) || res.length === 0) {
                throw new Error("Query returned no results");
            }

            // Check if we have multiple rows
            if (res.length > 1) {
                throw new Error("Multiple values were found, expected only one value");
            }

            const firstRow = res[0];
            const columnNames = Object.keys(firstRow);

            // Check if we have multiple columns
            if (columnNames.length > 1) {
                throw new Error("Multiple columns were found, expected only one value");
            }

            // Return the single value from the first (and only) column
            return firstRow[columnNames[0]];
        });
    }
}

/**
 * Connect, run one query under a deadline, always close the connection.
 *
 * mysql2's `connectTimeout` bounds the handshake and a per-query `timeout`
 * bounds the command, but neither is set by default and neither covers every
 * stall (a server that stops answering mid-handshake, a driver path that
 * never settles). The watchdog destroys the connection and settles the check,
 * and the connection is closed on success, error and timeout alike — a
 * timed-out check must not leak its connection.
 *
 * A rejected value from `shape` rejects the check; a thrown error does too.
 * @param {string} connectionString The database connection string
 * @param {?string} password Optional password override
 * @param {string} query The query to execute
 * @param {number} timeoutMs Deadline for connecting and querying
 * @param {(result: any) => any} shape Turns the raw result into the check's value
 * @returns {Promise<any>} The shaped result
 */
function runMysqlQuery(connectionString, password, query, timeoutMs, shape) {
    const deadline = Math.max(100, Number(timeoutMs) || 0);
    return new Promise((resolve, reject) => {
        const connection = mysql.createConnection({
            uri: connectionString,
            password,
            connectTimeout: deadline,
        });

        let settled = false;
        let timer = null;

        /**
         * Settle once and always release the connection.
         * @param {Error|undefined} error Failure, if any
         * @param {*} value Value to resolve with
         * @returns {void}
         */
        const finish = (error, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            try {
                connection.destroy();
            } catch {
                // Already closed; cleanup must never mask the check result.
            }
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        };

        timer = setTimeout(
            () => finish(new Error(`MySQL connection/query timed out after ${Math.round(deadline / 1000)}s`)),
            deadline
        );

        connection.on("error", (err) => finish(err));

        connection.query({ sql: query, timeout: deadline }, (err, res) => {
            if (err) {
                finish(err);
                return;
            }
            try {
                finish(undefined, shape(res));
            } catch (shapeError) {
                finish(shapeError);
            }
        });
    });
}

module.exports = {
    MysqlMonitorType,
};
