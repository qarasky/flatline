const { MonitorType, operationTimeoutMs } = require("./monitor-type");
const { UP } = require("../../src/util");
const redis = require("redis");

/**
 * How long a Redis command may run, in ms.
 *
 * node-redis (v5, as installed) has no per-command timeout option, so the
 * monitor enforces one itself: the ping is raced against a timer, and on
 * expiry the client is destroyed, which tears the socket down and settles the
 * command. Without this, a server that accepts the connection and then stops
 * answering left the check — and the monitor loop that awaits it — pending
 * forever, with no beats and no recovery alerts.
 * @param {number} timeoutMs Monitor deadline in milliseconds
 * @returns {number} Command deadline, floored so a tiny value still allows progress
 */
function commandDeadlineMs(timeoutMs) {
    return Math.max(100, Number(timeoutMs) || 0);
}

class RedisMonitorType extends MonitorType {
    name = "redis";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        heartbeat.msg = await this.redisPingAsync(
            monitor.databaseConnectionString,
            !monitor.ignoreTls,
            operationTimeoutMs(monitor)
        );
        heartbeat.status = UP;
    }

    /**
     * Redis server ping, bounded by the monitor timeout.
     * @param {string} dsn The redis connection string
     * @param {boolean} rejectUnauthorized If false, allows unverified server certificates.
     * @param {number} timeoutMs Deadline for connecting and for the ping itself
     * @returns {Promise<any>} Response from redis server
     */
    redisPingAsync(dsn, rejectUnauthorized, timeoutMs = operationTimeoutMs({})) {
        const deadline = commandDeadlineMs(timeoutMs);
        return new Promise((resolve, reject) => {
            const client = redis.createClient({
                url: dsn,
                socket: {
                    rejectUnauthorized,
                    // Bound the handshake too: a server that accepts the TCP
                    // connection and never speaks would otherwise hang here.
                    connectTimeout: deadline,
                },
            });

            let settled = false;
            let timer = null;

            /**
             * Settle once and always release the client.
             * @param {Error|undefined} error Failure, if any
             * @param {*} result Ping result
             * @returns {void}
             */
            const finish = (error, result) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                // destroy() closes the socket immediately; disconnect() waits
                // for in-flight commands, which is exactly what must not happen
                // on a deadline.
                try {
                    client.destroy();
                } catch {
                    // Already closed; cleanup must never mask the check result.
                }
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            };

            timer = setTimeout(
                () => finish(new Error(`Redis command timed out after ${Math.round(deadline / 1000)}s`)),
                deadline
            );

            client.on("error", (err) => finish(err));

            client.connect().then(() => {
                if (settled) {
                    return;
                }
                if (!client.isOpen) {
                    finish(new Error("Redis connection is not open"));
                    return;
                }
                client.ping().then(
                    (res) => finish(undefined, res),
                    (error) => finish(error)
                );
            }, (error) => finish(error));
        });
    }
}

module.exports = {
    RedisMonitorType,
};
