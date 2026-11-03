import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const css = read("../app/globals.css");
const layout = read("../app/layout.tsx");
const nextConfig = read("../next.config.ts");

describe("theme", () => {
    it("takes every token from kore-ui", () => {
        expect(css).toContain('@import "@qarasky/kore-ui/theme.css";');
        expect(css).toContain('@source "../node_modules/@qarasky/kore-ui/src";');
        expect(nextConfig).toContain('"@qarasky/kore-ui"');
    });

    it("does not redefine kore-ui's tokens or keep shadcn's", () => {
        for (const name of [
            "--background",
            "--foreground",
            "--primary",
            "--muted-foreground",
            "--sidebar",
            "--radius",
        ]) {
            expect(css).not.toMatch(new RegExp(`^\\s*${name}:`, "m"));
        }
        expect(css).not.toMatch(/--color-(bg|surface|raised|text|muted|accent|border):/);
        expect(css).not.toContain("tw-animate-css");
    });

    it("loads nothing from another origin", () => {
        expect(css).not.toMatch(/https?:\/\//);
    });

    it("lets kore-ui bring Inter", () => {
        expect(layout).not.toContain("@fontsource");
    });
});
