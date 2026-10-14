/**
 * Tests for the monitor `provider` field that Superboard cards draw logos
 * from.
 *
 * Covers the migration column and the REST round trip through the real
 * router: create (with normalisation), read, partial update, clearing back
 * to null, and the list used by the board.
 */
process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

import { test } from "node:test";
import assert from "node:assert";

import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("monitor provider field", async (t) => {
    let base = "";
    let server: any = null;
    let token = "";
    let monitorID = 0;

    t.before(async () => {
        await testDb.create();
        await auth();

        await auth().api.createUser({
            body: {
                name: "admin",
                email: "admin@noreply.uptime-kuma.internal",
                password: "Kuma-Test-8f4Q2xR9p",
                role: "admin",
                data: { username: "admin" },
            },
        });

        const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
        UptimeKumaServer.getInstance().io = { sockets: null, to: () => ({ emit: () => {} }) };

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/api-v1-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        base = `http://127.0.0.1:${server.address().port}`;

        const { R } = require("redbean-node");
        const passwordHash = require("../../server/password-hash");
        const owner = await R.findOne("better_auth_user", " email = ? ", ["admin@noreply.uptime-kuma.internal"]);
        const key = R.dispense("api_key");
        key.key = await passwordHash.generate("write-secret");
        key.name = "provider test";
        key.active = true;
        key.user_id = owner.id;
        key.scopes = "read,write";
        await R.store(key);
        token = `uk${key.id}_write-secret`;
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    const call = async (method: string, path: string, body?: any) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json() };
    };

    await t.test("the column exists and is nullable", async () => {
        const { R } = require("redbean-node");
        const info = await R.knex("monitor").columnInfo();
        assert.ok("provider" in info, "provider column missing");
        assert.strictEqual(info.provider.nullable, true, "provider must be nullable");
    });

    await t.test("the API advertises provider as writable", async () => {
        const { status, body } = await call("GET", "/api/v1/monitor-types");
        assert.strictEqual(status, 200);
        assert.ok(body.writableFields.includes("provider"), "provider is not writable");
    });

    await t.test("create normalises the provider and returns it", async () => {
        const { status, body } = await call("POST", "/api/v1/monitors", {
            name: "Provider Host",
            type: "http",
            url: "https://example.com",
            active: false,
            provider: "  HETZNER.com ",
        });
        assert.strictEqual(status, 201);
        assert.strictEqual(body.monitor.provider, "hetzner.com");
        monitorID = body.monitor.id;

        const { R } = require("redbean-node");
        const row = await R.findOne("monitor", " id = ? ", [monitorID]);
        assert.strictEqual(row.provider, "hetzner.com");
    });

    await t.test("read and list serve the provider", async () => {
        const one = await call("GET", `/api/v1/monitors/${monitorID}`);
        assert.strictEqual(one.body.monitor.provider, "hetzner.com");

        const list = await call("GET", "/api/v1/monitors?q=Provider%20Host");
        const found = list.body.monitors.find((m: any) => m.id === monitorID);
        assert.strictEqual(found.provider, "hetzner.com");
    });

    await t.test("a monitor without a provider reads null", async () => {
        const { body } = await call("POST", "/api/v1/monitors", {
            name: "Unhosted Host",
            type: "http",
            url: "https://example.org",
            active: false,
        });
        assert.strictEqual(body.monitor.provider, null);
    });

    await t.test("patch replaces, keeps on partial, and clears the provider", async () => {
        const replaced = await call("PATCH", `/api/v1/monitors/${monitorID}`, { provider: "ps.kz" });
        assert.strictEqual(replaced.body.monitor.provider, "ps.kz");

        // A partial PATCH that does not mention provider leaves it alone.
        const renamed = await call("PATCH", `/api/v1/monitors/${monitorID}`, { name: "Provider Host 2" });
        assert.strictEqual(renamed.body.monitor.provider, "ps.kz");

        // An explicit null clears it: the form's "none" option.
        const cleared = await call("PATCH", `/api/v1/monitors/${monitorID}`, { provider: null });
        assert.strictEqual(cleared.body.monitor.provider, null);
    });
});
