/**
 * Tests for the shared monitor service that REST v1 uses.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("monitor-service normalisation", async (t) => {
    t.before(async () => {
        await testDb.create();

        await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: {
                    username: "admin",
                },
            },
        });
    });

    t.after(async () => {
        await testDb.destroy();
    });

    // Required lazily so redbean-node is not captured before the DB exists.
    const service = () => require("../../server/monitor-service");

    await t.test("strips frontend-only properties", () => {
        const out = service().normaliseMonitorPayload({
            name: "x",
            humanReadableInterval: "1 min",
            responsecheck: "y",
            globalpingdnsresolvetypeoptions: [ "a" ],
        });

        assert.strictEqual(out.humanReadableInterval, undefined);
        assert.strictEqual(out.responsecheck, undefined);
        assert.strictEqual(out.globalpingdnsresolvetypeoptions, undefined);
        assert.strictEqual(out.name, "x");
    });

    await t.test("serialises accepted_statuscodes to JSON", () => {
        const out = service().normaliseMonitorPayload({
            accepted_statuscodes: [ "200-299" ],
        });

        assert.strictEqual(out.accepted_statuscodes, undefined);
        assert.strictEqual(out.accepted_statuscodes_json, JSON.stringify([ "200-299" ]));
    });

    await t.test("rejects non-string accepted_statuscodes", () => {
        assert.throws(() => service().normaliseMonitorPayload({
            accepted_statuscodes: [ 200, 299 ],
        }), /Accepted status codes are not all strings/);
    });

    await t.test("maps camelCase properties to snake_case columns", () => {
        const out = service().normaliseMonitorPayload({
            retryOnlyOnStatusCodeFailure: true,
            saveResponse: true,
            responseMaxLength: 1024,
            expectedTlsAlert: "handshake_failure",
            ntpStratumThreshold: 1,
        });

        assert.strictEqual(out.retryOnlyOnStatusCodeFailure, undefined);
        assert.strictEqual(out.retry_only_on_status_code_failure, true);
        assert.strictEqual(out.save_response, true);
        assert.strictEqual(out.response_max_length, 1024);
        assert.strictEqual(out.expected_tls_alert, "handshake_failure");
        assert.strictEqual(out.ntp_stratum_threshold, 1);
    });

    await t.test("serialises structured fields to JSON strings", () => {
        const out = service().normaliseMonitorPayload({
            conditions: [ { id: "c1" } ],
            rabbitmqNodes: [ "a:5672" ],
            kafkaProducerBrokers: [ "k:9092" ],
        });

        assert.strictEqual(typeof out.conditions, "string");
        assert.strictEqual(typeof out.rabbitmqNodes, "string");
        assert.strictEqual(typeof out.kafkaProducerBrokers, "string");
    });

    await t.test("coerces a numeric port and nulls a blank one", () => {
        assert.strictEqual(service().normaliseMonitorPayload({ port: "8080" }).port, 8080);
        assert.strictEqual(service().normaliseMonitorPayload({ port: "" }).port, null);
    });

    await t.test("drops a non-integer proxyId", () => {
        assert.strictEqual(service().normaliseMonitorPayload({ proxyId: "x" }).proxyId, null);
        assert.strictEqual(service().normaliseMonitorPayload({ proxyId: 3 }).proxyId, 3);
    });

    await t.test("normalises the provider id used for Superboard logos", () => {
        assert.strictEqual(service().normaliseMonitorPayload({ provider: "  HETZNER.com " }).provider, "hetzner.com");
        assert.strictEqual(service().normaliseMonitorPayload({ provider: "" }).provider, null);
        assert.strictEqual(service().normaliseMonitorPayload({ provider: "   " }).provider, null);
        assert.strictEqual(service().normaliseMonitorPayload({ provider: 42 }).provider, null);
        assert.strictEqual(service().normaliseMonitorPayload({ provider: "x".repeat(200) }).provider.length, 128);

        // Absent stays absent, so a partial PATCH never clears it.
        assert.strictEqual("provider" in service().normaliseMonitorPayload({ name: "x" }), false);
    });

    await t.test("repairs retryInterval and timeout like the UI does", () => {
        const out = service().applyIntervalDefaults({ interval: 60 });

        // The schema allows 0 but validate() rejects below 1, so it mirrors
        // the interval instead.
        assert.strictEqual(out.retryInterval, 60);
        assert.strictEqual(out.timeout, 48);
    });

    await t.test("defaults interval to 20 when absent", () => {
        const out = service().applyIntervalDefaults({});

        assert.strictEqual(out.interval, 20);
        assert.strictEqual(out.retryInterval, 20);
    });

    await t.test("keeps an explicit interval and timeout", () => {
        const out = service().applyIntervalDefaults({ interval: 120, timeout: 30 });

        assert.strictEqual(out.interval, 120);
        assert.strictEqual(out.timeout, 30);
    });
});
