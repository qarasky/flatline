/**
 * Tests for the auth REST router (server/routers/auth-router.js).
 *
 * This is the cutover replacement for the socket handlers the Vue frontend
 * used: password login that mints a bearer token, setup status, invite
 * check/redeem, and account administration. Mounted on an ephemeral express
 * app; the authenticated half is exercised with a real token minted by the
 * login endpoint itself.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";

// @ts-ignore
import { auth } from "../../server/better-auth";
// @ts-ignore
import TestDB from "../mock-testdb";

const testDb = new TestDB();

function fakeIo() {
    return {
        sockets: null,
        to: () => ({ emit: () => {} }),
    };
}

test("auth REST", async (t) => {
    let base = "";
    let server: any = null;
    let adminToken = "";
    let adminID = "";

    const post = async (path: string, body: any, token: string | null = null) => {
        const res = await fetch(`${base}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    const get = async (path: string, token: string | null = null) => {
        const res = await fetch(`${base}${path}`, {
            headers: {
                Accept: "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
        });
        return { status: res.status, body: await res.json() };
    };

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
        UptimeKumaServer.getInstance().io = fakeIo();

        const express = require("express");
        const app = express();
        app.use(require("../../server/routers/auth-router"));

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address();
        base = `http://127.0.0.1:${address.port}`;

        const { R } = require("redbean-node");
        const owner = await R.findOne("better_auth_user", " email = ? ", ["admin@noreply.uptime-kuma.internal"]);
        adminID = owner.id;
    });

    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await testDb.destroy();
    });

    await t.test("setup reports false when an account exists", async () => {
        const { status, body } = await get("/api/v1/auth/setup");
        assert.strictEqual(status, 200);
        assert.strictEqual(body.setupNeeded, false);
    });

    await t.test("login rejects missing fields", async () => {
        assert.strictEqual((await post("/api/v1/auth/login", {})).status, 400);
        assert.strictEqual((await post("/api/v1/auth/login", { username: "admin" })).status, 400);
    });

    await t.test("login rejects a bad password without a username oracle", async () => {
        const wrong = await post("/api/v1/auth/login", { username: "admin", password: "wrong-pass" });
        const unknown = await post("/api/v1/auth/login", { username: "nobody-here", password: "wrong-pass" });
        assert.strictEqual(wrong.status, 401);
        assert.strictEqual(unknown.status, 401);
        assert.strictEqual(wrong.body.message, unknown.body.message);
    });

    await t.test("login mints a working full-scope token", async () => {
        const { status, body } = await post("/api/v1/auth/login", {
            username: "admin",
            password: "Kuma-Test-8f4Q2xR9p",
        });
        assert.strictEqual(status, 200);
        assert.match(body.token, /^uk[0-9]+_.+/);
        assert.strictEqual(body.user.username, "admin");
        adminToken = body.token;

        const me = await get("/api/v1/auth/me", adminToken);
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.body.user.username, "admin");
        assert.deepStrictEqual(me.body.scopes, ["read", "write", "publish"]);
    });

    await t.test("me rejects a missing token", async () => {
        assert.strictEqual((await get("/api/v1/auth/me")).status, 401);
    });

    await t.test("login accepts the password alone when the instance has one account", async () => {
        const { status, body } = await post("/api/v1/auth/login", { password: "Kuma-Test-8f4Q2xR9p" });
        assert.strictEqual(status, 200);
        assert.match(body.token, /^uk[0-9]+_.+/);
        assert.strictEqual(body.user.username, "admin");
    });

    await t.test("login without a username still rejects a bad password", async () => {
        const { status, body } = await post("/api/v1/auth/login", { password: "wrong-pass" });
        assert.strictEqual(status, 401);
        assert.strictEqual(body.message, "Invalid username or password.");
    });

    await t.test("2FA: required without a code, verified with one", async () => {
        const { R } = require("redbean-node");
        const { symmetricEncrypt } = require("better-auth/crypto");
        const { getAuthSecret } = require("../../server/better-auth");
        const { createOTP } = require("@better-auth/utils/otp");

        // Enrol TOTP the way the plugin stores it: encrypted secret, verified.
        const secret = "JBSWY3DPEHPK3PXP";
        await R.exec(
            "INSERT INTO better_auth_twoFactor (id, secret, backupCodes, verified, userId) VALUES (?, ?, ?, 1, ?)",
            ["totp-test-row", await symmetricEncrypt({ key: getAuthSecret(), data: secret }), "[]", adminID]
        );

        try {
            const noCode = await post("/api/v1/auth/login", {
                username: "admin",
                password: "Kuma-Test-8f4Q2xR9p",
            });
            assert.strictEqual(noCode.status, 401);
            assert.strictEqual(noCode.body.error, "two_factor_required");

            const badCode = await post("/api/v1/auth/login", {
                username: "admin",
                password: "Kuma-Test-8f4Q2xR9p",
                totp: "000000",
            });
            assert.strictEqual(badCode.status, 401);

            const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
            const good = await post("/api/v1/auth/login", {
                username: "admin",
                password: "Kuma-Test-8f4Q2xR9p",
                totp: code,
            });
            assert.strictEqual(good.status, 200);
            assert.match(good.body.token, /^uk[0-9]+_.+/);
        } finally {
            await R.exec("DELETE FROM better_auth_twoFactor WHERE id = ?", ["totp-test-row"]);
        }
    });

    await t.test("users: list, ban blocks login, delete removes", async () => {
        // Mint + redeem an invite for a throwaway account.
        const minted = await post("/api/v1/invites", {}, adminToken);
        assert.strictEqual(minted.status, 200);

        const redeemed = await post(`/api/v1/auth/invites/${minted.body.token}/redeem`, {
            username: "temp.user",
            password: "Temp-User-99",
        });
        assert.strictEqual(redeemed.status, 200);

        const listed = await get("/api/v1/users", adminToken);
        assert.strictEqual(listed.body.count, 2);
        const temp = listed.body.users.find((u: any) => u.username === "temp.user");
        assert.ok(temp && !temp.isCurrent);

        const banned = await fetch(`${base}/api/v1/users/${temp.id}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({ banned: true }),
        });
        assert.strictEqual(banned.status, 200);

        const bannedLogin = await post("/api/v1/auth/login", {
            username: "temp.user",
            password: "Temp-User-99",
        });
        assert.strictEqual(bannedLogin.status, 403);

        const deleted = await fetch(`${base}/api/v1/users/${temp.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.strictEqual(deleted.status, 200);

        const relisted = await get("/api/v1/users", adminToken);
        assert.strictEqual(relisted.body.count, 1);
    });

    await t.test("users: cannot delete yourself or a stranger", async () => {
        const self = await fetch(`${base}/api/v1/users/${adminID}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.strictEqual(self.status, 400);

        const ghost = await fetch(`${base}/api/v1/users/does-not-exist`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.strictEqual(ghost.status, 404);
    });

    await t.test("password-only login asks for a username once a second account exists", async () => {
        const minted = await post("/api/v1/invites", {}, adminToken);
        const redeemed = await post(`/api/v1/auth/invites/${minted.body.token}/redeem`, {
            username: "second.operator",
            password: "Second-Operator-99",
        });
        assert.strictEqual(redeemed.status, 200);

        // The password alone is ambiguous with several accounts, so the API
        // asks for a username instead of trying it against each account.
        const passwordOnly = await post("/api/v1/auth/login", { password: "Kuma-Test-8f4Q2xR9p" });
        assert.strictEqual(passwordOnly.status, 400);
        assert.strictEqual(passwordOnly.body.error, "username_required");

        const withUsername = await post("/api/v1/auth/login", {
            username: "admin",
            password: "Kuma-Test-8f4Q2xR9p",
        });
        assert.strictEqual(withUsername.status, 200);

        const users = await get("/api/v1/users", adminToken);
        const extra = users.body.users.find((u: any) => u.username === "second.operator");
        await fetch(`${base}/api/v1/users/${extra.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
    });

    await t.test("invites: mint, list, check, double redeem fails", async () => {
        const minted = await post("/api/v1/invites", { note: "hello" }, adminToken);
        assert.strictEqual(minted.status, 200);
        assert.ok(minted.body.token.length > 20);

        const listed = await get("/api/v1/invites", adminToken);
        assert.strictEqual(listed.status, 200);
        assert.ok(listed.body.count >= 1);

        const checked = await get(`/api/v1/auth/invites/${minted.body.token}`);
        assert.strictEqual(checked.status, 200);
        assert.strictEqual(checked.body.status, "active");

        const first = await post(`/api/v1/auth/invites/${minted.body.token}/redeem`, {
            username: "invited.user",
            password: "Invited-User-99",
        });
        assert.strictEqual(first.status, 200);

        const second = await post(`/api/v1/auth/invites/${minted.body.token}/redeem`, {
            username: "invited.other",
            password: "Invited-Other-99",
        });
        assert.strictEqual(second.status, 410);

        // Clean up the invited account through the endpoint under test.
        const users = await get("/api/v1/users", adminToken);
        const extra = users.body.users.find((u: any) => u.username === "invited.user");
        await fetch(`${base}/api/v1/users/${extra.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
    });

    await t.test("invites: taken username does not burn the link", async () => {
        const minted = await post("/api/v1/invites", {}, adminToken);

        const conflict = await post(`/api/v1/auth/invites/${minted.body.token}/redeem`, {
            username: "admin",
            password: "Some-Pass-99",
        });
        assert.strictEqual(conflict.status, 409);

        // The link survives and redeems for someone else.
        const retry = await post(`/api/v1/auth/invites/${minted.body.token}/redeem`, {
            username: "second.chance",
            password: "Second-Chance-99",
        });
        assert.strictEqual(retry.status, 200);

        const users = await get("/api/v1/users", adminToken);
        const extra = users.body.users.find((u: any) => u.username === "second.chance");
        await fetch(`${base}/api/v1/users/${extra.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
    });

    await t.test("invites: revoke kills an unused link", async () => {
        const minted = await post("/api/v1/invites", {}, adminToken);

        const revoked = await fetch(`${base}/api/v1/invites/${minted.body.inviteID}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.strictEqual(revoked.status, 200);

        const checked = await get(`/api/v1/auth/invites/${minted.body.token}`);
        assert.strictEqual(checked.status, 404);
    });

    await t.test("invites: bad expiry is rejected", async () => {
        assert.strictEqual((await post("/api/v1/invites", { expiryHours: 9999 }, adminToken)).status, 400);
    });
});
