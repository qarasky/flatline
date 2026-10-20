import test from "node:test";
import assert from "node:assert/strict";
import { nextPagePhase, parseResolveHost, retryDelayMs, shouldBackOff } from "../src/lib/status-snapshot.ts";
import { fetchStatusPage } from "../../../packages/shared/src/client.ts";

const snapshot = (extra = {}) => ({
    data: { config: { title: "Acme" }, publicGroupList: [], incidents: [] },
    heartbeats: { 1: [{ status: 1 }] },
    history: [],
    ...extra,
});

test("only a successful {slug:null} means the host is unmapped", () => {
    assert.deepEqual(parseResolveHost(true, { ok: true, slug: null, matched: false }), { kind: "unmapped" });
    assert.deepEqual(parseResolveHost(true, { ok: true, slug: "acme" }), { kind: "mapped", slug: "acme" });
    assert.equal(parseResolveHost(false, null).kind, "error");
    assert.equal(parseResolveHost(true, null).kind, "error");
    assert.equal(parseResolveHost(true, { ok: true }).kind, "error");
    assert.equal(parseResolveHost(true, { slug: "" }).kind, "error");
    assert.equal(parseResolveHost(true, "<html>").kind, "error");
});

test("retry delay backs off from 2 s to a 60 s cap with bounded jitter", () => {
    const mid = () => 0.5;
    assert.equal(retryDelayMs(0, mid), 2_000);
    assert.equal(retryDelayMs(1, mid), 4_000);
    assert.equal(retryDelayMs(4, mid), 32_000);
    assert.equal(retryDelayMs(5, mid), 60_000);
    assert.equal(retryDelayMs(50, mid), 60_000);
    assert.equal(
        retryDelayMs(0, () => 0),
        1_600
    );
    assert.equal(
        retryDelayMs(0, () => 0.9999),
        2_400
    );
});

test("a failed refresh keeps the last good page and marks it stale", () => {
    const first = nextPagePhase({ phase: "loading" }, { kind: "ok", snapshot: snapshot() }, "acme", 1000);
    assert.equal(first.phase, "page");
    assert.equal(first.stale, false);
    assert.equal(first.updatedAt, 1000);

    const failed = nextPagePhase(first, { kind: "error", message: "502" }, "acme", 2000);
    assert.equal(failed.phase, "page");
    assert.equal(failed.stale, true);
    assert.equal(failed.updatedAt, 1000, "stale since the last good load");
    assert.equal(failed.snapshot, first.snapshot);

    const recovered = nextPagePhase(failed, { kind: "ok", snapshot: snapshot() }, "acme", 3000);
    assert.equal(recovered.stale, false);
    assert.equal(recovered.updatedAt, 3000);

    // Without anything on screen an error is an error.
    assert.deepEqual(nextPagePhase({ phase: "loading" }, { kind: "error", message: "502" }, "acme", 1), {
        phase: "error",
        message: "502",
    });
    // A different slug never inherits another page's snapshot.
    assert.equal(nextPagePhase(first, { kind: "error", message: "x" }, "other", 2).phase, "error");
    // Authoritative answers replace the page.
    assert.equal(nextPagePhase(first, { kind: "locked" }, "acme", 2).phase, "locked");
    assert.equal(nextPagePhase(first, { kind: "notfound" }, "acme", 2).phase, "notfound");
});

test("carried-over heartbeats count as stale from the last good load", () => {
    const first = nextPagePhase({ phase: "loading" }, { kind: "ok", snapshot: snapshot() }, "acme", 1000);
    const degraded = { kind: "ok", snapshot: snapshot({ degraded: ["heartbeats"] }) };
    const next = nextPagePhase(first, degraded, "acme", 5000);
    assert.equal(next.stale, true);
    assert.equal(next.updatedAt, 1000);
    assert.equal(shouldBackOff(degraded), true);
    assert.equal(shouldBackOff({ kind: "ok", snapshot: snapshot({ degraded: ["history"] }) }), false);
    assert.equal(shouldBackOff({ kind: "error", message: "x" }), true);
    assert.equal(shouldBackOff({ kind: "notfound" }), false);
});

test("fetchStatusPage keeps previous heartbeats and history when those requests fail", async () => {
    const originalFetch = globalThis.fetch;
    const json = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let failParts = true;
    globalThis.fetch = async (url) => {
        if (url.includes("/heartbeat/") || url.includes("/incident-history")) {
            return failParts
                ? json({ error: "busy" }, 503)
                : url.includes("/heartbeat/")
                  ? json({ ok: true, heartbeatList: { 2: [] } })
                  : json({ ok: true, incidents: [{ id: 9 }] });
        }
        return json({ config: { title: "Acme" }, publicGroupList: [], incidents: [] });
    };
    try {
        const previous = { heartbeats: { 1: [{ status: 1 }] }, history: [{ id: 3 }] };
        const kept = await fetchStatusPage("", "acme", { previous });
        assert.deepEqual(kept.heartbeats, previous.heartbeats);
        assert.deepEqual(kept.history, previous.history);
        assert.deepEqual(kept.degraded, ["heartbeats", "history"]);

        const empty = await fetchStatusPage("", "acme");
        assert.deepEqual(empty.heartbeats, {});
        assert.deepEqual(empty.history, []);

        failParts = false;
        const fresh = await fetchStatusPage("", "acme", { previous });
        assert.deepEqual(fresh.heartbeats, { 2: [] });
        assert.deepEqual(fresh.history, [{ id: 9 }]);
        assert.equal("degraded" in fresh, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
