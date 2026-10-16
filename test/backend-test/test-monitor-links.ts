/**
 * Tests for server -> website links: the migration table and the REST round
 * trip through the real router (create, set, resolve, group expansion, bulk,
 * validation and cascade cleanup).
 */
process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

import { test } from "node:test";
import assert from "node:assert";

import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

test("monitor links", async (t) => {
    let base = "";
    let server: any = null;
    let token = "";

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
        key.name = "links test";
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

    const create = async (payload: Record<string, unknown>): Promise<number> => {
        const { body } = await call("POST", "/api/v1/monitors", { active: false, ...payload });
        return body.monitor.id;
    };

    await t.test("the table exists", async () => {
        const { R } = require("redbean-node");
        const info = await R.knex("monitor_link").columnInfo();
        assert.ok("monitor_id" in info && "linked_monitor_id" in info, "monitor_link columns missing");
    });

    let serverID = 0;
    let webA = 0;
    let webB = 0;

    await t.test("links are set, listed and cleared", async () => {
        serverID = await create({ name: "Host", type: "push" });
        webA = await create({ name: "site-a", type: "http", url: "https://a.example" });
        webB = await create({ name: "site-b", type: "http", url: "https://b.example" });

        const put = await call("PUT", `/api/v1/monitors/${serverID}/links`, { linkedMonitorIds: [ webA, webB ] });
        assert.strictEqual(put.status, 200);
        assert.strictEqual(put.body.raw.length, 2);
        assert.strictEqual(put.body.resolved.length, 2);
        assert.strictEqual(put.body.resolved[0].status, 2, "no heartbeat yet = pending");
        assert.strictEqual(put.body.resolved[0].via, webA);

        const get = await call("GET", `/api/v1/monitors/${serverID}/links`);
        assert.strictEqual(get.body.resolved.length, 2);

        // A heartbeat on a linked website flows into the resolved status.
        const { R } = require("redbean-node");
        const beat = R.dispense("heartbeat");
        beat.monitor_id = webA;
        beat.status = 0;
        beat.msg = "boom";
        beat.time = new Date().toISOString().slice(0, 19).replace("T", " ");
        await R.store(beat);

        const down = await call("GET", `/api/v1/monitors/${serverID}/links`);
        const resolvedA = down.body.resolved.find((link: any) => link.id === webA);
        assert.strictEqual(resolvedA.status, 0, "latest heartbeat drives the chip status");
    });

    await t.test("a group link expands to its websites", async () => {
        const group = await create({ name: "clients", type: "group" });
        const child = await create({ name: "client-site", type: "http", url: "https://c.example", parent: group });

        const put = await call("PUT", `/api/v1/monitors/${serverID}/links`, { linkedMonitorIds: [ group ] });
        assert.strictEqual(put.body.raw.length, 1);
        assert.strictEqual(put.body.raw[0].type, "group");
        const ids = put.body.resolved.map((link: any) => link.id);
        assert.ok(ids.includes(child), "group child resolves");
        const via = put.body.resolved.find((link: any) => link.id === child).via;
        assert.strictEqual(via, group, "attributed to the group link");
    });

    await t.test("replace is exact and drops self/unknown/duplicates", async () => {
        const put = await call("PUT", `/api/v1/monitors/${serverID}/links`, {
            linkedMonitorIds: [ serverID, webB, webB, 999999 ],
        });
        assert.strictEqual(put.body.raw.length, 1);
        assert.strictEqual(put.body.raw[0].linkedMonitorId, webB);
    });

    await t.test("bulk returns links keyed by server", async () => {
        const other = await create({ name: "Host 2", type: "push" });
        await call("PUT", `/api/v1/monitors/${other}/links`, { linkedMonitorIds: [ webA ] });

        const { status, body } = await call("GET", `/api/v1/monitors/links?ids=${serverID},${other}`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.count, 2);
        assert.strictEqual(body.servers[serverID].resolved[0].id, webB);
        assert.strictEqual(body.servers[other].resolved[0].id, webA);
    });

    await t.test("input is validated", async () => {
        const bad = await call("PUT", `/api/v1/monitors/${serverID}/links`, { linkedMonitorIds: "nope" });
        assert.strictEqual(bad.status, 400);

        const empty = await call("GET", "/api/v1/monitors/links?ids=");
        assert.strictEqual(empty.status, 400);

        const missing = await call("GET", "/api/v1/monitors/999999/links");
        assert.strictEqual(missing.status, 404);
    });

    await t.test("deleting a monitor removes its links", async () => {
        await call("DELETE", `/api/v1/monitors/${webB}`);
        const afterTarget = await call("GET", `/api/v1/monitors/${serverID}/links`);
        assert.strictEqual(afterTarget.body.raw.length, 0, "target deletion drops the link");

        const { R } = require("redbean-node");
        await R.exec("DELETE FROM monitor_link");
        await R.exec("INSERT INTO monitor_link (monitor_id, linked_monitor_id) VALUES (?, ?)", [ serverID, webA ]);
        await call("DELETE", `/api/v1/monitors/${serverID}`);
        const rows = await R.getAll("SELECT id FROM monitor_link");
        assert.strictEqual(rows.length, 0, "server deletion drops its links");
    });
});
