import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const css = read("../app/globals.css");
const layout = read("../app/layout.tsx");

/** The declarations inside the first `:root { ... }` block, whitespace collapsed. */
function rootBlock(source: string): string {
    const match = /:root\s*\{([^}]*)\}/.exec(source);
    return (match?.[1] ?? "").replace(/\s+/g, " ");
}

// Brand from qarasky/ai-docs (Kore) mapped onto shadcn's variables. shadcn's
// "accent" is a hover surface, not the brand colour, which is "primary".
const expected: Record<string, string> = {
    "--background": "#16181d",
    "--foreground": "#e6e8ee",
    "--card": "#1d2026",
    "--popover": "#23262d",
    "--primary": "#5b8def",
    "--primary-foreground": "#ffffff",
    "--secondary": "#23262d",
    "--muted": "#1d2026",
    "--muted-foreground": "#8a8f9a",
    "--accent": "#23262d",
    "--accent-foreground": "#e6e8ee",
    "--border": "#2c3038",
    "--input": "#2c3038",
    "--ring": "#5b8def",
    "--sidebar": "#1d2026",
    "--sidebar-primary": "#5b8def",
    "--sidebar-accent": "#23262d",
    "--sidebar-border": "#2c3038",
    "--sidebar-ring": "#5b8def",
    "--radius": "0.375rem",
    "--status-up": "#3fb950",
    "--status-warn": "#f0c54b",
    "--status-down": "#e5484d",
    "--status-muted": "#8a3a3d",
    "--status-maint": "#a371f7",
    "--surface": "#1d2026",
    "--raised": "#23262d",
    "--border-strong": "#3a3f49",
    "--accent-hover": "#7aa3f2",
};

describe("theme", () => {
    const root = rootBlock(css);

    for (const [name, value] of Object.entries(expected)) {
        it(`sets ${name} to ${value}`, () => {
            expect(root).toContain(`${name}: ${value};`);
        });
    }

    it("is dark only", () => {
        expect(css).toContain("color-scheme: dark");
        expect(css).not.toMatch(/\.dark\s*\{/);
    });

    it("loads nothing from another origin", () => {
        expect(css).not.toMatch(/https?:\/\//);
    });

    it("bundles Inter instead of fetching it", () => {
        expect(layout).toContain('import "@fontsource-variable/inter"');
    });
});
