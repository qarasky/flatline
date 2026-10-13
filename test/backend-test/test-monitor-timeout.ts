/**
 * Legacy zero-timeout fallback (server/model/monitor.js).
 *
 * The runtime fallback used to multiply the interval by 1000 twice: a 60s
 * interval got a 48,000s (13h) timeout, because consumers already treat
 * `timeout` as seconds. The fallback now assigns seconds, and the stored
 * rows are normalized once by migration.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB("./data/test-monitor-timeout");

test("legacy zero timeouts are normalized", async (t) => {
    const { R } = require("redbean-node");
    const Monitor = require("../../server/model/monitor");
    let ownerID = "";

    t.before(async () => {
        await testDb.create();
        const { auth } = require("../../server/better-auth");
        await auth();
        await auth().api.createUser({
            body: {
                name: "admin", email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p", role: "admin", data: { username: "admin" },
            },
        });
        const owner = await R.findOne("better_auth_user", " email = ? ", [ "admin@noreply.uptime-kuma.internal" ]);
        ownerID = owner.id;
    });

    t.after(async () => {
        await testDb.destroy();
    });

    await t.test("the runtime fallback is 80% of the interval in seconds", () => {
        // 48 seconds for a 60s interval, not 48,000.
        assert.strictEqual(Monitor.ensureTimeout({ interval: 60, timeout: 0 }).timeout, 48);
        assert.strictEqual(Monitor.ensureTimeout({ interval: 180, timeout: 0 }).timeout, 144);
        assert.strictEqual(Monitor.ensureTimeout({ interval: 20, timeout: -5 }).timeout, 16);

        // A usable timeout is never touched.
        assert.strictEqual(Monitor.ensureTimeout({ interval: 60, timeout: 30 }).timeout, 30);

        // A missing/zero interval cannot produce a zero timeout either.
        assert.strictEqual(Monitor.ensureTimeout({ interval: 0, timeout: 0 }).timeout, 48);
        assert.strictEqual(Monitor.ensureTimeout({ timeout: null }).timeout, 48);
    });

    await t.test("the migration normalizes stored zero-timeout rows", async () => {
        const insert = async (name: string, interval: number, timeout: number | null) => {
            const monitor = R.dispense("monitor");
            monitor.user_id = ownerID;
            monitor.name = name;
            monitor.type = "push";
            monitor.interval = interval;
            monitor.retryInterval = interval;
            monitor.timeout = timeout;
            monitor.active = 1;
            await R.store(monitor);
            return monitor.id;
        };

        const zero = await insert("zero", 60, 0);
        const longer = await insert("longer", 180, 0);
        const valid = await insert("valid", 60, 30);

        const migration = require("../../db/knex_migrations/2026-10-14-0000-normalize-monitor-timeout");
        await migration.up(R.knex);

        const timeouts = async (id: number) => (await R.findOne("monitor", " id = ? ", [ id ])).timeout;
        assert.strictEqual(await timeouts(zero), 48);
        assert.strictEqual(await timeouts(longer), 144);
        assert.strictEqual(await timeouts(valid), 30, "a valid timeout is left alone");
    });
});
