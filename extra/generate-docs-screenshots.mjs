// Usage: VITE_FLATLINE_URL= npm --prefix apps/dashboard run build
//        node extra/generate-docs-screenshots.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { monitors, samples, history, NOW } from "./docs-fixtures.mjs";

const dist = resolve("apps/dashboard/dist");
const output = resolve("docs/screenshots");
await readFile(resolve(dist, "index.html"));
await mkdir(output, { recursive: true });
const streams = new Set();
const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/v1/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write('data: {"type":"ready"}\n\n');
        streams.add(res); req.on("close", () => streams.delete(res)); return;
    }
    if (url.pathname.startsWith("/api/")) {
        let body;
        if (url.pathname === "/api/v1/monitors") {
            body = { ok: true, count: monitors.length, monitors,
                pagination: { page: 1, perPage: 200, total: monitors.length, totalPages: 1, hasMore: false } };
        } else if (url.pathname === "/api/v1/monitors/metrics/latest") {
            body = { ok: true, samples };
        } else if (/^\/api\/v1\/monitors\/\d+\/metrics\/summary$/.test(url.pathname)) {
            body = history(Number(url.pathname.split("/")[4]), Number(url.searchParams.get("hours") || 1));
        } else {
            res.writeHead(404); res.end("Unknown fixture API route"); return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); return;
    }
    const asset = url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg";
    const path = asset ? resolve(dist, `.${url.pathname}`) : resolve(dist, "index.html");
    if (!path.startsWith(`${dist}/`)) { res.writeHead(403); res.end(); return; }
    try {
        const data = await readFile(path);
        res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(path)] || "application/octet-stream" });
        res.end(data);
    } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "UTC" });
    const blocked = [];
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { blocked.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await context.addInitScript(() => localStorage.setItem("flatline.token", "documentation-only-not-a-real-token"));
    const page = await context.newPage();
    await page.clock.install({ time: new Date(NOW) });
    await page.goto(origin);
    await page.getByText("Example applications").waitFor();
    await page.screenshot({ path: resolve(output, "dashboard.png"), animations: "disabled" });
    await page.goto(`${origin}/superboard`);
    await page.locator(".fleet-card").first().waitFor();
    await page.screenshot({ path: resolve(output, "superboard.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Open load history for gpu-render" }).click();
    await page.locator(".history-chart svg").first().waitFor();
    await page.screenshot({ path: resolve(output, "history.png"), animations: "disabled" });
    if (blocked.length) { throw new Error(`Blocked unexpected non-fixture requests: ${blocked.join(", ")}`); }
    console.log(`Generated dashboard.png, superboard.png and history.png in ${output}; all data fictional.`);
} finally {
    await browser?.close();
    for (const res of streams) { res.end(); }
    await new Promise(r => server.close(r));
}
