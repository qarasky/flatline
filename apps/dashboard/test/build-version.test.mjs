import test from "node:test";
import assert from "node:assert/strict";
import {
    buildFingerprintFromHtml,
    entryAssetFromHtml,
    isNewBuild,
    loadedBuildFingerprint,
    loadedEntryAsset,
    startVersionWatch,
} from "../src/lib/build-version.ts";

const viteHtml = (hash, css = "Cm37BaMZ") => `<!doctype html>
<html lang="en" class="dark">
  <head>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=flatline-1" />
    <script type="module" crossorigin src="/assets/index-${hash}.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/TokenGate-abc.js">
    <link rel="stylesheet" crossorigin href="/assets/index-${css}.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

test("the hashed entry script is read from built index.html", () => {
    assert.equal(entryAssetFromHtml(viteHtml("tGS1SSt4")), "/assets/index-tGS1SSt4.js");
    assert.equal(
        entryAssetFromHtml(
            `<script src="https://cdn.example/x.js"></script><script type=module src='https://h/assets/index-Q.js?v=1'></script>`
        ),
        "/assets/index-Q.js"
    );
    // The dev server's unhashed entry and pages without one are unknown.
    assert.equal(entryAssetFromHtml('<script type="module" src="/src/main.tsx"></script>'), null);
    assert.equal(entryAssetFromHtml("<html>502 Bad Gateway</html>"), null);
});

test("a CSS-only deploy changes the fingerprint too", () => {
    assert.equal(buildFingerprintFromHtml(viteHtml("a")), "/assets/index-a.js|/assets/index-Cm37BaMZ.css");
    assert.notEqual(buildFingerprintFromHtml(viteHtml("a", "new")), buildFingerprintFromHtml(viteHtml("a")));
    assert.equal(buildFingerprintFromHtml("<html>502</html>"), null);
    // The live document: the static stylesheet first, runtime-injected lazy
    // chunk styles after it.
    const doc = {
        querySelectorAll: (selector) =>
            selector.startsWith("link")
                ? [{ getAttribute: () => "/assets/index-Cm37BaMZ.css" }, { getAttribute: () => "/assets/Lazy-x.css" }]
                : [{ getAttribute: () => "/assets/index-a.js" }],
    };
    assert.equal(loadedBuildFingerprint(doc), buildFingerprintFromHtml(viteHtml("a")));
});

test("only two known, different entries mean a new build", () => {
    assert.equal(isNewBuild("/assets/index-a.js", "/assets/index-b.js"), true);
    assert.equal(isNewBuild("/assets/index-a.js", "/assets/index-a.js"), false);
    assert.equal(isNewBuild(null, "/assets/index-b.js"), false);
    assert.equal(isNewBuild("/assets/index-a.js", null), false);
});

test("the loaded entry comes from the module script in the document", () => {
    const doc = {
        querySelectorAll: () => [
            { getAttribute: () => "/src/main.tsx" },
            { getAttribute: () => "/assets/index-live.js" },
        ],
    };
    assert.equal(loadedEntryAsset(doc), "/assets/index-live.js");
    assert.equal(loadedEntryAsset({ querySelectorAll: () => [] }), null);
});

test("the watcher checks on resync, reports a new build once, then stops", async () => {
    const listeners = new Set();
    globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    let served = "/assets/index-a.js";
    let fetches = 0;
    let found = 0;
    const stop = startVersionWatch({
        loaded: "/assets/index-a.js",
        intervalMs: 60_000,
        minGapMs: 0,
        fetchServed: async () => {
            fetches++;
            return served;
        },
        onResync: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        onNewVersion: () => found++,
    });
    const resync = async () => {
        listeners.forEach((l) => l());
        await new Promise((r) => setTimeout(r, 5));
    };
    try {
        await resync();
        assert.equal(fetches, 1);
        assert.equal(found, 0);
        served = "/assets/index-b.js";
        await resync();
        assert.equal(found, 1);
        assert.equal(listeners.size, 0, "stops listening after detection");
        await resync();
        assert.equal(fetches, 2);
    } finally {
        stop();
        delete globalThis.document;
    }

    // In development there is nothing to compare, so nothing is fetched.
    let devFetches = 0;
    startVersionWatch({ loaded: null, fetchServed: async () => devFetches++, onNewVersion: () => {} })();
    assert.equal(devFetches, 0);
});
