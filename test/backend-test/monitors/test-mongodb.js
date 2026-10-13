const { describe, test } = require("node:test");
const assert = require("node:assert");
const mongodb = require("mongodb");
const { MongodbMonitorType } = require("../../../server/monitor-types/mongodb");
const { UP, PENDING } = require("../../../src/util");

const originalConnect = mongodb.MongoClient.connect;

/**
 * Replace MongoClient.connect with a fake for the duration of one test.
 * @param {Function} connect Replacement implementation
 * @returns {void}
 */
function stubConnect(connect) {
    mongodb.MongoClient.connect = connect;
}

describe("MongodbMonitorType client lifecycle", () => {
    test.after(() => {
        stubConnect(originalConnect);
    });

    test("a failed command still closes its client", async () => {
        // The audit's reproduction: throwing from command() skipped close(),
        // and every retry leaked another connected client and its pool.
        let closed = 0;
        stubConnect(async () => ({
            db: () => ({
                command: async () => {
                    throw new Error("not authorized on admin to execute command");
                },
            }),
            close: async () => {
                closed++;
            },
        }));

        const monitorType = new MongodbMonitorType();
        await assert.rejects(
            monitorType.check({ databaseConnectionString: "mongodb://127.0.0.1:1/db" }, { status: PENDING }, {}),
            /not authorized/
        );
        assert.strictEqual(closed, 1, "the client must be closed even when the command throws");
    });

    test("a successful command closes its client", async () => {
        let closed = 0;
        stubConnect(async () => ({
            db: () => ({ command: async () => ({ ok: 1 }) }),
            close: async () => {
                closed++;
            },
        }));

        const heartbeat = { status: PENDING, msg: "" };
        await new MongodbMonitorType().check({ databaseConnectionString: "mongodb://127.0.0.1:1/db" }, heartbeat, {});
        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(closed, 1);
    });

    test("the monitor timeout bounds client selection and the command", async () => {
        let options = null;
        let commandOptions = null;
        stubConnect(async (_url, connectOptions) => {
            options = connectOptions;
            return {
                db: () => ({
                    command: async (_command, runOptions) => {
                        commandOptions = runOptions;
                        return { ok: 1 };
                    },
                }),
                close: async () => {},
            };
        });

        await new MongodbMonitorType().check(
            { databaseConnectionString: "mongodb://127.0.0.1:1/db", timeout: 12 },
            { status: PENDING, msg: "" },
            {}
        );
        assert.strictEqual(options.serverSelectionTimeoutMS, 12_000, "server selection must be bounded");
        assert.strictEqual(commandOptions.timeoutMS, 12_000, "the command must be bounded");
    });
});
