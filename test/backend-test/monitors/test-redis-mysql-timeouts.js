/**
 * Connection/command deadlines for the Redis and MySQL monitor types
 * (follow-up finding: both could stop their monitor indefinitely).
 *
 * Redis is exercised against a real socket fixture that completes the TCP
 * handshake and never answers, because that is the failure the audit
 * reproduced. MySQL's protocol fixture would need a hand-buildable handshake,
 * so its driver surface is stubbed instead: the test asserts the deadline
 * options reach mysql2 and that a query that never settles still ends the
 * check (and destroys its connection) within the deadline.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { PENDING } = require("../../../src/util");

const { RedisMonitorType } = require("../../../server/monitor-types/redis");
const { MysqlMonitorType } = require("../../../server/monitor-types/mysql");

/**
 * A TCP server that accepts connections, never answers, and tracks the live
 * server-side sockets. `resume()` is required for Node to observe a peer FIN.
 * @returns {Promise<{server: net.Server, port: number, sockets: Set}>} Fixture
 */
async function silentServer() {
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.resume();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: server.address().port, sockets };
}

/**
 * Shut a silentServer fixture down.
 * @param {{server: net.Server, sockets: Set}} fixture Fixture
 * @returns {Promise<void>} Resolves when closed
 */
async function closeFixture(fixture) {
    for (const socket of fixture.sockets) {
        socket.destroy();
    }
    await new Promise((resolve) => fixture.server.close(resolve));
}

describe("Redis monitor deadlines", () => {
    test("check() times out and releases its client when the server never answers", async () => {
        const fixture = await silentServer();
        const redisMonitor = new RedisMonitorType();
        const monitor = {
            databaseConnectionString: `redis://127.0.0.1:${fixture.port}`,
            ignoreTls: true,
            timeout: 0.3,
        };

        const started = Date.now();
        try {
            await assert.rejects(
                redisMonitor.check(monitor, { msg: "", status: PENDING }, {}),
                /timed out|Redis/i
            );
            const elapsed = Date.now() - started;
            assert.ok(elapsed < 5000, `check settled in ${elapsed}ms`);

            // The client is destroyed, so the fixture sees the socket go.
            const deadline = Date.now() + 3000;
            while (fixture.sockets.size > 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.strictEqual(fixture.sockets.size, 0, "the timed-out check must not hold its socket");
        } finally {
            await closeFixture(fixture);
        }
    });

    test("the monitor timeout bounds the handshake too", async () => {
        const fixture = await silentServer();
        const redisMonitor = new RedisMonitorType();
        try {
            const started = Date.now();
            await assert.rejects(
                redisMonitor.redisPingAsync(`redis://127.0.0.1:${fixture.port}`, true, 200)
            );
            assert.ok(Date.now() - started < 3000, "the handshake deadline applies");
        } finally {
            await closeFixture(fixture);
        }
    });
});

describe("MySQL monitor deadlines", () => {
    /** The mysql module, whose createConnection the tests replace. */
    const mysql = require("mysql2");

    test("check() passes the monitor timeout to the driver and to the query", async () => {
        const originalCreate = mysql.createConnection;
        let connectOptions = null;
        let queryOptions = null;
        mysql.createConnection = (options) => {
            connectOptions = options;
            return {
                on: () => {},
                query: (queryArg, cb) => {
                    queryOptions = queryArg;
                    cb(null, [ { COUNT: 1 } ]);
                },
                destroy: () => {},
                end: () => {},
            };
        };

        try {
            const heartbeat = { msg: "", status: PENDING };
            await new MysqlMonitorType().check(
                { databaseConnectionString: "mysql://user:pass@127.0.0.1:3306/db", timeout: 12 },
                heartbeat,
                {}
            );
            assert.strictEqual(connectOptions.connectTimeout, 12_000, "handshake bounded");
            assert.strictEqual(queryOptions.timeout, 12_000, "query bounded");
            assert.strictEqual(queryOptions.sql, "SELECT 1", "the query itself is unchanged");
            assert.strictEqual(heartbeat.status, 1, "the check succeeds normally");
        } finally {
            mysql.createConnection = originalCreate;
        }
    });

    test("check() settles and destroys its connection when the query never answers", async () => {
        const originalCreate = mysql.createConnection;
        let destroyed = false;
        mysql.createConnection = () => ({
            on: () => {},
            // Never calls back: the driver's own timeout cannot help here.
            query: () => {},
            destroy: () => {
                destroyed = true;
            },
            end: () => {},
        });

        try {
            const started = Date.now();
            await assert.rejects(
                new MysqlMonitorType().check(
                    { databaseConnectionString: "mysql://user:pass@127.0.0.1:3306/db", timeout: 0.3 },
                    { msg: "", status: PENDING },
                    {}
                ),
                /timed out/i
            );
            const elapsed = Date.now() - started;
            assert.ok(elapsed < 5000, `check settled in ${elapsed}ms`);
            assert.strictEqual(destroyed, true, "the timed-out check releases its connection");
        } finally {
            mysql.createConnection = originalCreate;
        }
    });

    test("a query error still cleans up and surfaces the message", async () => {
        const originalCreate = mysql.createConnection;
        let destroyed = false;
        mysql.createConnection = () => ({
            on: () => {},
            query: (_query, cb) => cb(new Error("Access denied for user")),
            destroy: () => {
                destroyed = true;
            },
            end: () => {},
        });

        try {
            await assert.rejects(
                new MysqlMonitorType().check(
                    { databaseConnectionString: "mysql://user:pass@127.0.0.1:3306/db", timeout: 5 },
                    { msg: "", status: PENDING },
                    {}
                ),
                /Access denied/
            );
            assert.strictEqual(destroyed, true);
        } finally {
            mysql.createConnection = originalCreate;
        }
    });
});
