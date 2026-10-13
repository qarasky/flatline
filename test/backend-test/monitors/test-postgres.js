const { describe, test } = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const { PostgresMonitorType } = require("../../../server/monitor-types/postgres");
const { UP, PENDING } = require("../../../src/util");

/**
 * A TCP server that completes the handshake, keeps the connection open and
 * never answers a Postgres protocol message — the audit's fixture for a
 * database that hangs. `sockets` tracks live server-side connections so a
 * test can prove the client released its end (`resume()` is required for
 * Node to observe the peer's FIN).
 * @returns {Promise<{server: net.Server, port: number, sockets: Set}>} Fixture
 */
async function silentPostgresServer() {
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
 * Shut a silentPostgresServer fixture down.
 * @param {{server: net.Server, sockets: Set}} fixture Fixture
 * @returns {Promise<void>} Resolves when closed
 */
async function closeFixture(fixture) {
    for (const socket of fixture.sockets) {
        socket.destroy();
    }
    await new Promise((resolve) => fixture.server.close(resolve));
}

test("check() times out when the server accepts but never answers", async () => {
    // A server that completes the TCP handshake and then stays silent was
    // the audit's reproduction: the check stayed pending forever because no
    // deadline reached the connection or the query.
    const fixture = await silentPostgresServer();
    const postgresMonitor = new PostgresMonitorType();
    const monitor = {
        databaseConnectionString: `postgres://user:secret@127.0.0.1:${fixture.port}/db`,
        timeout: 0.2,
    };
    const heartbeat = { msg: "", status: PENDING };

    const started = Date.now();
    try {
        await assert.rejects(postgresMonitor.check(monitor, heartbeat, {}), /timeout|timed out/i);
        assert.ok(Date.now() - started < 5000, `check settled in ${Date.now() - started}ms`);
    } finally {
        await closeFixture(fixture);
    }
});

test("check() releases its connection on timeout instead of leaking it", async () => {
    const fixture = await silentPostgresServer();
    const postgresMonitor = new PostgresMonitorType();
    const monitor = {
        databaseConnectionString: `postgres://user:secret@127.0.0.1:${fixture.port}/db`,
        timeout: 0.2,
    };

    try {
        await assert.rejects(postgresMonitor.check(monitor, { msg: "", status: PENDING }, {}));
        // end() closes a never-authenticated connection immediately; the
        // delayed destroy is the guarantee. Wait for the socket to vanish.
        const deadline = Date.now() + 3000;
        while (fixture.sockets.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.strictEqual(fixture.sockets.size, 0, "the timed-out check must not hold its socket");
    } finally {
        await closeFixture(fixture);
    }
});

describe(
    "Postgres Single Node",
    {
        skip:
            (!!process.env.CI && (process.platform !== "linux" || process.arch !== "x64")) ||
            process.env.SKIP_TESTCONTAINER,
    },
    () => {
        test("check() sets status to UP when Postgres server is reachable", async () => {
            // The default timeout of 30 seconds might not be enough for the container to start
            const postgresContainer = await new PostgreSqlContainer("postgres:latest")
                .withStartupTimeout(60000)
                .start();
            const postgresMonitor = new PostgresMonitorType();
            const monitor = {
                databaseConnectionString: postgresContainer.getConnectionUri(),
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            try {
                await postgresMonitor.check(monitor, heartbeat, {});
                assert.strictEqual(heartbeat.status, UP);
            } finally {
                postgresContainer.stop();
            }
        });

        test("check() rejects when Postgres server is not reachable", async () => {
            const postgresMonitor = new PostgresMonitorType();
            const monitor = {
                databaseConnectionString: "http://localhost:15432",
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            // regex match any string
            const regex = /.+/;

            await assert.rejects(postgresMonitor.check(monitor, heartbeat, {}), regex);
        });
    }
);
