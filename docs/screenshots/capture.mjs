// Regenerate the documentation screenshots from the local dev stack.
//
//   ./dev.sh                                   # backend :3001, web app :3003, mock fleet
//   npm ci && npx playwright install chromium  # from the repository root
//   node docs/screenshots/capture.mjs
//
// Writes superboard.png, dashboard.png and history.png (1920x1080, device
// scale factor 1) next to this file. The data is the mock fleet, not a real
// installation. Sign in to the dev web app through Kore ID in a browser and
// pass that browser's fl_session cookie as FLATLINE_SESSION before running.
//
// Updated for the Next.js web app (port, routes, the history dialog) but not
// rerun since the cutover; check the images after regenerating.
import { chromium } from "playwright";

const session = process.env.FLATLINE_SESSION;
const base = "http://127.0.0.1:3003";
if (!session) {
    throw new Error("set FLATLINE_SESSION to the fl_session cookie from a Kore ID sign-in");
}

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
});
// The cookie comes from a real Kore ID sign-in; there is no token sign-in.
await context.addCookies([{ name: "fl_session", value: session, url: base }]);
const page = await context.newPage();
page.on("pageerror", (error) => console.error("page error:", error.message));

async function openBoard() {
    await page.goto(`${base}/superboard?perPage=8`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".fleet-card", { timeout: 20000 });
    await page.waitForTimeout(6000);
}

// 1. The Superboard: all eight demo servers on one page, no rotation.
await openBoard();
console.log(`superboard.png: ${await page.locator(".fleet-card").count()} cards`);
await page.screenshot({ path: "docs/screenshots/superboard.png" });

// 2. The operator board: grouped monitor table with the summary bar.
await page.goto(`${base}/monitors`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await page.screenshot({ path: "docs/screenshots/dashboard.png" });
console.log("dashboard.png");

// 3. Server history: a host with CPU, RAM and GPU readings, on the 1h range.
await openBoard();
await page
    .locator(".fleet-card", { has: page.locator('.fleet-name:has-text("gpu-01")') })
    .locator(".fleet-history-link")
    .first()
    .click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ timeout: 15000 });
await page.waitForTimeout(3000);

const oneHour = dialog.getByRole("button", { name: "1h", exact: true });
if (await oneHour.count()) {
    await oneHour.click();
    await page.waitForTimeout(3500);
}
await dialog.screenshot({ path: "docs/screenshots/history.png" });
console.log("history.png");

await browser.close();
