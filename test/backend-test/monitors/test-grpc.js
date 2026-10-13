const { describe, test } = require("node:test");
const assert = require("node:assert");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const { GrpcKeywordMonitorType } = require("../../../server/monitor-types/grpc");
const { UP, PENDING } = require("../../../src/util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const testProto = `
syntax = "proto3";
package test;

service TestService {
    rpc Echo (EchoRequest) returns (EchoResponse);
}

message EchoRequest {
    string message = 1;
}

message EchoResponse {
    string message = 1;
}
`;

/**
 * Create a gRPC server for testing
 * @param {number} port Port to listen on
 * @param {object} methodHandlers Object with method handlers
 * @returns {Promise<grpc.Server>} gRPC server instance
 */
async function createTestGrpcServer(port, methodHandlers) {
    // Write proto to temp file
    const tmpDir = os.tmpdir();
    const protoPath = path.join(tmpDir, `test-${port}.proto`);
    fs.writeFileSync(protoPath, testProto);

    // Load proto file
    const packageDefinition = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const testPackage = protoDescriptor.test;

    const server = new grpc.Server();

    // Add service implementation
    server.addService(testPackage.TestService.service, {
        Echo: (call, callback) => {
            if (methodHandlers.Echo) {
                methodHandlers.Echo(call, callback);
            } else {
                callback(null, { message: call.request.message });
            }
        },
    });

    return new Promise((resolve, reject) => {
        server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
            if (err) {
                reject(err);
            } else {
                server.start();
                // Clean up temp file
                fs.unlinkSync(protoPath);
                resolve(server);
            }
        });
    });
}

test("check() times out when the server accepts the call and never answers", async () => {
    // The audit's second reproduction: no deadline was passed to
    // makeUnaryRequest, so an unanswered call held the check (and the
    // monitor loop awaiting it) open forever.
    const port = 50056;
    const server = await createTestGrpcServer(port, {
        Echo: (call, callback) => {
            // Accept the call and never reply.
        },
    });

    const grpcMonitor = new GrpcKeywordMonitorType();
    const monitor = {
        grpcUrl: `localhost:${port}`,
        grpcProtobuf: testProto,
        grpcServiceName: "test.TestService",
        grpcMethod: "echo",
        grpcBody: JSON.stringify({ message: "test" }),
        keyword: "SUCCESS",
        invertKeyword: false,
        grpcEnableTls: false,
        timeout: 0.2,
        isInvertKeyword: () => false,
    };

    const heartbeat = {
        msg: "",
        status: PENDING,
    };

    const started = Date.now();
    try {
        await assert.rejects(grpcMonitor.check(monitor, heartbeat, {}), (err) => {
            // grpc-js cancels the RPC at the deadline; the backstop timer is
            // the fallback for a callback that never arrives at all.
            return err.code === grpc.status.DEADLINE_EXCEEDED || /timed out/i.test(err.message);
        });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 5000, `check settled in ${elapsed}ms`);
    } finally {
        server.forceShutdown();
    }
});

test("check() closes the channel it created, on success and on failure", async () => {
    // The audit's leak: constructGrpcService allocated a client per check and
    // nothing closed it, so channels, registrations and timers piled up. The
    // test spies on Client.prototype.close (the generic client's instances
    // inherit it) rather than relying on process handles.
    const port = 50057;
    const server = await createTestGrpcServer(port, {
        Echo: (call, callback) => {
            callback(null, { message: "SUCCESS in every reply" });
        },
    });

    const originalClose = grpc.Client.prototype.close;
    let closes = 0;
    grpc.Client.prototype.close = function (...args) {
        closes++;
        return originalClose.apply(this, args);
    };

    const grpcMonitor = new GrpcKeywordMonitorType();
    const monitor = {
        grpcUrl: `localhost:${port}`,
        grpcProtobuf: testProto,
        grpcServiceName: "test.TestService",
        grpcMethod: "echo",
        grpcBody: JSON.stringify({ message: "test" }),
        keyword: "SUCCESS",
        invertKeyword: false,
        grpcEnableTls: false,
        timeout: 5,
        isInvertKeyword: () => false,
    };

    try {
        const heartbeat = { msg: "", status: PENDING };
        await grpcMonitor.check(monitor, heartbeat, {});
        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(closes, 1, "a successful check must close its channel");

        // A failing keyword check throws, and the channel must still close.
        await assert.rejects(
            grpcMonitor.check({ ...monitor, keyword: "MISSING" }, { msg: "", status: PENDING }, {})
        );
        assert.strictEqual(closes, 2, "a failed check must close its channel");

        // So must a check that times out (never-answering server).
        const silent = await createTestGrpcServer(50058, { Echo: () => {} });
        try {
            await assert.rejects(
                grpcMonitor.check({ ...monitor, grpcUrl: "localhost:50058", timeout: 0.2 }, { msg: "", status: PENDING }, {})
            );
            assert.strictEqual(closes, 3, "a timed-out check must close its channel");
        } finally {
            silent.forceShutdown();
        }
    } finally {
        grpc.Client.prototype.close = originalClose;
        server.forceShutdown();
    }
});

describe(
    "GrpcKeywordMonitorType",
    {
        skip: !!process.env.CI && (process.platform !== "linux" || process.arch !== "x64"),
    },
    () => {
        test("check() sets status to UP when keyword is found in response", async () => {
            const port = 50051;
            const server = await createTestGrpcServer(port, {
                Echo: (call, callback) => {
                    callback(null, { message: "Hello World with SUCCESS keyword" });
                },
            });

            const grpcMonitor = new GrpcKeywordMonitorType();
            const monitor = {
                grpcUrl: `localhost:${port}`,
                grpcProtobuf: testProto,
                grpcServiceName: "test.TestService",
                grpcMethod: "echo",
                grpcBody: JSON.stringify({ message: "test" }),
                keyword: "SUCCESS",
                invertKeyword: false,
                grpcEnableTls: false,
                isInvertKeyword: () => false,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            try {
                await grpcMonitor.check(monitor, heartbeat, {});
                assert.strictEqual(heartbeat.status, UP);
                assert.ok(heartbeat.msg.includes("SUCCESS"));
                assert.ok(heartbeat.msg.includes("is"));
            } finally {
                server.forceShutdown();
            }
        });

        test("check() rejects when keyword is not found in response", async () => {
            const port = 50052;
            const server = await createTestGrpcServer(port, {
                Echo: (call, callback) => {
                    callback(null, { message: "Hello World without the expected keyword" });
                },
            });

            const grpcMonitor = new GrpcKeywordMonitorType();
            const monitor = {
                grpcUrl: `localhost:${port}`,
                grpcProtobuf: testProto,
                grpcServiceName: "test.TestService",
                grpcMethod: "echo",
                grpcBody: JSON.stringify({ message: "test" }),
                keyword: "MISSING",
                invertKeyword: false,
                grpcEnableTls: false,
                isInvertKeyword: () => false,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            try {
                await assert.rejects(grpcMonitor.check(monitor, heartbeat, {}), (err) => {
                    assert.ok(err.message.includes("MISSING"));
                    assert.ok(err.message.includes("not"));
                    return true;
                });
            } finally {
                server.forceShutdown();
            }
        });

        test("check() rejects when inverted keyword is present in response", async () => {
            const port = 50053;
            const server = await createTestGrpcServer(port, {
                Echo: (call, callback) => {
                    callback(null, { message: "Response with ERROR keyword" });
                },
            });

            const grpcMonitor = new GrpcKeywordMonitorType();
            const monitor = {
                grpcUrl: `localhost:${port}`,
                grpcProtobuf: testProto,
                grpcServiceName: "test.TestService",
                grpcMethod: "echo",
                grpcBody: JSON.stringify({ message: "test" }),
                keyword: "ERROR",
                invertKeyword: true,
                grpcEnableTls: false,
                isInvertKeyword: () => true,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            try {
                await assert.rejects(grpcMonitor.check(monitor, heartbeat, {}), (err) => {
                    assert.ok(err.message.includes("ERROR"));
                    assert.ok(err.message.includes("present"));
                    return true;
                });
            } finally {
                server.forceShutdown();
            }
        });

        test("check() sets status to UP when inverted keyword is not present in response", async () => {
            const port = 50054;
            const server = await createTestGrpcServer(port, {
                Echo: (call, callback) => {
                    callback(null, { message: "Response without error keyword" });
                },
            });

            const grpcMonitor = new GrpcKeywordMonitorType();
            const monitor = {
                grpcUrl: `localhost:${port}`,
                grpcProtobuf: testProto,
                grpcServiceName: "test.TestService",
                grpcMethod: "echo",
                grpcBody: JSON.stringify({ message: "test" }),
                keyword: "ERROR",
                invertKeyword: true,
                grpcEnableTls: false,
                isInvertKeyword: () => true,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            try {
                await grpcMonitor.check(monitor, heartbeat, {});
                assert.strictEqual(heartbeat.status, UP);
                assert.ok(heartbeat.msg.includes("ERROR"));
                assert.ok(heartbeat.msg.includes("not"));
            } finally {
                server.forceShutdown();
            }
        });

        test("check() rejects when gRPC server is unreachable", async () => {
            const grpcMonitor = new GrpcKeywordMonitorType();
            const monitor = {
                grpcUrl: "localhost:50099",
                grpcProtobuf: testProto,
                grpcServiceName: "test.TestService",
                grpcMethod: "echo",
                grpcBody: JSON.stringify({ message: "test" }),
                keyword: "SUCCESS",
                invertKeyword: false,
                grpcEnableTls: false,
                isInvertKeyword: () => false,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await assert.rejects(grpcMonitor.check(monitor, heartbeat, {}), (err) => {
                // Should fail with connection error
                return true;
            });
        });

        test("check() truncates long response messages in error output", async () => {
            const port = 50055;
            const longMessage = "A".repeat(100) + " with SUCCESS keyword";

            const server = await createTestGrpcServer(port, {
                Echo: (call, callback) => {
                    callback(null, { message: longMessage });
                },
            });

            const grpcMonitor = new GrpcKeywordMonitorType();
            const monitor = {
                grpcUrl: `localhost:${port}`,
                grpcProtobuf: testProto,
                grpcServiceName: "test.TestService",
                grpcMethod: "echo",
                grpcBody: JSON.stringify({ message: "test" }),
                keyword: "MISSING",
                invertKeyword: false,
                grpcEnableTls: false,
                isInvertKeyword: () => false,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            try {
                await assert.rejects(grpcMonitor.check(monitor, heartbeat, {}), (err) => {
                    // Should truncate message to 50 characters with "..."
                    assert.ok(err.message.includes("..."));
                    return true;
                });
            } finally {
                server.forceShutdown();
            }
        });
    }
);
