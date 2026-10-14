import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, faviconUrl, providerKey, providerLabel, resolveProvider } from "../src/lib/providers.ts";

test("known providers resolve to their bundled logo", () => {
    for (const provider of PROVIDERS) {
        for (const spelling of [
            provider.id,
            provider.domain,
            `https://${provider.domain}/pricing`,
            `WWW.${provider.domain}`,
        ]) {
            const resolved = resolveProvider(spelling);
            assert.equal(resolved?.id, provider.id, `${spelling} must resolve to ${provider.id}`);
            assert.equal(resolved?.logo, provider.logo);
            assert.equal(resolved?.custom, false);
        }
    }
});

test("every bundled logo exists in the public directory", () => {
    for (const provider of PROVIDERS) {
        const file = path.join(import.meta.dirname, "..", "public", provider.logo);
        assert.ok(fs.existsSync(file), `${provider.logo} is missing`);
    }
});

test("known provider aliases resolve to the canonical entry", () => {
    assert.equal(resolveProvider("hetzner.de")?.id, "hetzner");
    assert.equal(resolveProvider("hetzner.cloud")?.id, "hetzner");
});

test("an unknown domain falls back to its favicon", () => {
    const resolved = resolveProvider("Vultr.com");
    assert.equal(resolved?.custom, true);
    assert.equal(resolved?.label, "vultr.com");
    assert.equal(resolved?.logo, faviconUrl("vultr.com"));
});

test("an unknown slug without a domain has no logo to draw", () => {
    const resolved = resolveProvider("my-own-dc");
    assert.equal(resolved?.custom, true);
    assert.equal(resolved?.label, "my-own-dc");
    assert.equal(resolved?.logo, null);
    assert.equal(resolved?.domain, null);
});

test("blank and non-string providers resolve to nothing", () => {
    for (const value of [null, undefined, "", "   ", 42, {}]) {
        assert.equal(resolveProvider(value), null);
        assert.equal(providerKey(value), null);
        assert.equal(providerLabel(value), null);
    }
});

test("providerLabel falls back to the raw value", () => {
    assert.equal(providerLabel("hetzner.com"), "Hetzner");
    assert.equal(providerLabel("custom.example"), "custom.example");
});
