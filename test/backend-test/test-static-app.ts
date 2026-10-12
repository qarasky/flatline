/**
 * Serving the built web app from the backend process (v2 consolidation).
 *
 * The SPA shell answers client-side routes, hashed assets are immutable,
 * and API paths are never swallowed by the shell — their JSON 404s stay
 * JSON so scripts and agents keep getting parseable output.
 */
process.env.UPTIME_KUMA_HIDE_LOG = [ "info_db", "info_server" ].join(",");

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("static app serving", async (t) => {
    const express = require("express");
    const { mountStaticApp, isApiPath } = require("../../server/static-app");

    await t.test("isApiPath guards the API surface", async () => {
        for (const url of [ "/api", "/api/v1", "/upload", "/upload/x.png", "/metrics", "/.well-known/change-password" ]) {
            assert.equal(isApiPath(url), true, `${url} must be an API path`);
        }
        for (const url of [ "/", "/status/client-a", "/superboard/kiosk/work", "/apifoo", "/uploads" ]) {
            assert.equal(isApiPath(url), false, `${url} must not be an API path`);
        }
    });

    await t.test("missing build mounts nothing", async () => {
        const app = express();
        assert.equal(mountStaticApp(app, path.join(os.tmpdir(), "flatline-no-such-dist")), false);
    });

    await t.test("shell, assets and JSON 404s behave", async (st) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flatline-dist-"));
        fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Flatline</title>");
        fs.mkdirSync(path.join(dir, "assets"));
        fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
        fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");

        const app = express();
        app.get("/api/v1", (req: any, res: any) => res.json({ ok: true }));
        assert.equal(mountStaticApp(app, dir), true);
        // The same JSON catch-all server.js uses, last.
        app.use((req: any, res: any) => res.status(404).json({ ok: false, error: "not_found" }));

        const server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", () => resolve()));
        const base = `http://127.0.0.1:${(server.address() as any).port}`;

        const get = async (url: string, init?: RequestInit) => {
            const res = await fetch(`${base}${url}`, init);
            return { status: res.status, type: res.headers.get("content-type") ?? "", cache: res.headers.get("cache-control") ?? "", body: await res.text() };
        };

        try {
            const root = await get("/");
            assert.equal(root.status, 200);
            assert.match(root.body, /<title>Flatline<\/title>/);

            // Client-side routes survive a reload: the shell answers.
            for (const url of [ "/status/client-a", "/superboard/kiosk/work", "/invite/abc" ]) {
                const res = await get(url);
                assert.equal(res.status, 200, url);
                assert.match(res.body, /<title>Flatline<\/title>/, url);
            }

            const asset = await get("/assets/app-abc123.js");
            assert.equal(asset.status, 200);
            assert.match(asset.cache, /immutable/);
            assert.match(asset.cache, /max-age=31536000/);

            const missingAsset = await get("/assets/missing.js");
            assert.equal(missingAsset.status, 404, "a missing hashed asset is a real 404");
            assert.doesNotMatch(missingAsset.body, /<title>Flatline<\/title>/, "the shell must not answer asset misses");

            const favicon = await get("/favicon.svg");
            assert.equal(favicon.status, 200);
            assert.match(favicon.type, /svg/);

            const api = await get("/api/v1");
            assert.equal(api.status, 200);
            assert.deepEqual(JSON.parse(api.body), { ok: true });

            const apiMiss = await get("/api/nope");
            assert.equal(apiMiss.status, 404);
            assert.deepEqual(JSON.parse(apiMiss.body), { ok: false, error: "not_found" });

            const uploadMiss = await get("/upload/x.png");
            assert.equal(uploadMiss.status, 404);
            assert.deepEqual(JSON.parse(uploadMiss.body), { ok: false, error: "not_found" });

            const post = await fetch(`${base}/somewhere`, { method: "POST" });
            assert.equal(post.status, 404, "the SPA answers GET/HEAD only");
            assert.deepEqual(await post.json(), { ok: false, error: "not_found" });
        } finally {
            server.closeAllConnections?.();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
