const { MonitorType, operationTimeoutMs } = require("./monitor-type");
const { UP, log } = require("../../src/util");
const dayjs = require("dayjs");
const grpc = require("@grpc/grpc-js");
const protojs = require("protobufjs");

/**
 * Deadline for one gRPC call.
 *
 * The call's `deadline` option makes grpc-js cancel the RPC itself when it
 * expires: the server is told, the call is aborted, and the callback fires
 * with DEADLINE_EXCEEDED. The timer in grpcQuery is only a backstop so a
 * callback that never arrives cannot hold the monitor loop open.
 * @param {number} timeoutMs Deadline in milliseconds
 * @returns {Date} Absolute deadline for grpc-js
 */
function callDeadline(timeoutMs) {
    return new Date(Date.now() + timeoutMs);
}

class GrpcKeywordMonitorType extends MonitorType {
    name = "grpc-keyword";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const startTime = dayjs().valueOf();
        const timeoutMs = operationTimeoutMs(monitor);
        const service = this.constructGrpcService(
            monitor.grpcUrl,
            monitor.grpcProtobuf,
            monitor.grpcServiceName,
            monitor.grpcEnableTls,
            timeoutMs
        );
        let response = await this.grpcQuery(service, monitor.grpcMethod, monitor.grpcBody, timeoutMs);
        heartbeat.ping = dayjs().valueOf() - startTime;
        log.debug(this.name, "gRPC response:", response);
        let keywordFound = response.toString().includes(monitor.keyword);
        if (keywordFound !== !monitor.isInvertKeyword()) {
            log.debug(
                this.name,
                `GRPC response [${response}] + ", but keyword [${monitor.keyword}] is ${keywordFound ? "present" : "not"} in [" + ${response} + "]"`
            );

            let truncatedResponse = response.length > 50 ? response.toString().substring(0, 47) + "..." : response;

            throw new Error(
                `keyword [${monitor.keyword}] is ${keywordFound ? "present" : "not"} in [" + ${truncatedResponse} + "]`
            );
        }
        heartbeat.status = UP;
        heartbeat.msg = `${response}, keyword [${monitor.keyword}] ${keywordFound ? "is" : "not"} found`;
    }

    /**
     * Call one gRPC method under an explicit deadline.
     *
     * The audit reproduction: a server that accepts the connection and never
     * answers left the call (and the monitor's whole loop, which awaits it)
     * pending forever. The deadline cancels the call; the backstop timer
     * guarantees the promise settles even if the callback never fires.
     * @param {grpc.Service} service grpc Service
     * @param {string} method grpc Method
     * @param {string} body grpc Body
     * @param {number} timeoutMs Deadline in milliseconds
     * @returns {Promise<string>} Result of gRPC query
     */
    async grpcQuery(service, method, body, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            /**
             * Settle once, clearing the backstop.
             * @param {Function} settle resolve or reject
             * @param {*} value Result or error
             * @returns {void}
             */
            const finish = (settle, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                settle(value);
            };

            timer = setTimeout(
                () => finish(reject, new Error(`gRPC call timed out after ${Math.round(timeoutMs / 1000)}s`)),
                timeoutMs + 1000
            );

            try {
                service[method](JSON.parse(body), (err, response) => {
                    if (err) {
                        if (err.code !== 1) {
                            return finish(reject, err);
                        }
                        log.debug(this.name, `ignoring ${err.code} ${err.details}, as code=1 is considered OK`);
                        return finish(resolve, `${err.code} is considered OK because ${err.details}`);
                    }
                    finish(resolve, JSON.stringify(response));
                });
            } catch (err) {
                finish(reject, err);
            }
        });
    }

    /**
     * Create gRPC client, with every call bounded by the monitor timeout.
     * @param {string} url grpc Url
     * @param {string} protobufData grpc ProtobufData
     * @param {string} serviceName grpc ServiceName
     * @param {boolean} enableTls grpc EnableTls
     * @param {number} timeoutMs Deadline applied to each call
     * @returns {grpc.Service} grpc Service
     */
    constructGrpcService(url, protobufData, serviceName, enableTls, timeoutMs) {
        const protocObject = protojs.parse(protobufData);
        const protoServiceObject = protocObject.root.lookupService(serviceName);
        const Client = grpc.makeGenericClientConstructor({});
        const credentials = enableTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
        const client = new Client(url, credentials);
        return protoServiceObject.create(
            (method, requestData, cb) => {
                const fullServiceName = method.fullName;
                const serviceFQDN = fullServiceName.split(".");
                const serviceMethod = serviceFQDN.pop();
                const serviceMethodClientImpl = `/${serviceFQDN.slice(1).join(".")}/${serviceMethod}`;
                log.debug(this.name, `gRPC method ${serviceMethodClientImpl}`);
                client.makeUnaryRequest(
                    serviceMethodClientImpl,
                    (arg) => arg,
                    (arg) => arg,
                    requestData,
                    new grpc.Metadata(),
                    { deadline: callDeadline(timeoutMs) },
                    cb
                );
            },
            false,
            false
        );
    }
}

module.exports = {
    GrpcKeywordMonitorType,
};
