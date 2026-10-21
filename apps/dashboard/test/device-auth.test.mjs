import test from "node:test";
import assert from "node:assert/strict";
import { approveUrl, codeFromHash, hostMismatch, qrSvg } from "../src/lib/device-auth.ts";

test("approveUrl prefers the configured public URL", () => {
    assert.equal(approveUrl("https://kuma.example", "http://192.168.1.5:3001", "abc"), "https://kuma.example/device#abc");
});

test("approveUrl falls back to the origin the screen was opened on", () => {
    assert.equal(approveUrl(null, "http://192.168.1.5:3001", "abc"), "http://192.168.1.5:3001/device#abc");
});

test("approveUrl does not double slashes", () => {
    assert.equal(approveUrl("https://kuma.example/", "http://x", "abc"), "https://kuma.example/device#abc");
});

test("codeFromHash reads the fragment and rejects empty", () => {
    assert.equal(codeFromHash("#abc123"), "abc123");
    assert.equal(codeFromHash("abc123"), "abc123");
    assert.equal(codeFromHash("#"), null);
    assert.equal(codeFromHash(""), null);
});

test("qrSvg is an svg with a quiet zone and a square viewBox", () => {
    const svg = qrSvg("https://kuma.example/device#abc");
    assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(box, "viewBox is present");
    assert.equal(box[1], box[2], "the viewBox is square");
    // Version 3+ symbols are at least 29 modules; 4 modules of quiet zone on each side.
    assert.ok(Number(box[1]) >= 29 + 8);
    assert.ok(svg.includes('fill="#fff"') || svg.includes('fill="#ffffff"'), "light background under the modules");
});

test("hostMismatch is true only when the public URL differs from the origin", () => {
    assert.equal(hostMismatch(null, "http://192.168.1.5:3001"), false);
    assert.equal(hostMismatch("https://kuma.example", "https://kuma.example"), false);
    assert.equal(hostMismatch("https://kuma.example/", "https://kuma.example"), false);
    assert.equal(hostMismatch("https://kuma.example", "http://192.168.1.5:3001"), true);
});
