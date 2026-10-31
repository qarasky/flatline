import { describe, expect, it } from "vitest";

import { GET } from "@/app/index.html/route";

// The old dashboard's rule (its src/lib/build-version.ts, deleted at the cutover), copied:
// the first module script under /assets/ is the build's entry.
function entryAssetFromHtml(html: string): string | null {
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
        if (!/\btype\s*=\s*["']?module["']?/i.test(tag)) {
            continue;
        }
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const path = src ? new URL(src, "http://localhost").pathname : null;
        if (path && /\/assets\/[^/]+\.js$/.test(path)) {
            return path;
        }
    }
    return null;
}

describe("GET /index.html", () => {
    it("names an entry the old dashboard has never run, so an open old tab reloads", async () => {
        const response = GET();
        const html = await response.text();
        const entry = entryAssetFromHtml(html);
        expect(entry).not.toBeNull();
        expect(entry).not.toMatch(/\/assets\/index-/);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    });

    it("sends a person who opens it to the app", async () => {
        expect(await GET().text()).toMatch(/http-equiv="refresh" content="0; url=\/"/);
    });
});
