import test from "node:test";
import assert from "node:assert/strict";
import {
    bucketSummary,
    checkedAgo,
    formatPing,
    formatUptime,
    monitorTarget,
    summarySentence,
} from "../src/lib/board-format.ts";

const totals = (extra = {}) => ({ total: 33, up: 33, down: 0, pending: 0, maintenance: 0, paused: 0, ...extra });

test("uptime and ping read as numbers or a dash", () => {
    assert.equal(formatUptime(0.99995), "100.00%");
    assert.equal(formatUptime(0.5), "50.0%");
    assert.equal(formatUptime(null), "—");
    assert.equal(formatPing(141.6), "142 ms");
    assert.equal(formatPing(null), "—");
});

test("target text: hostname for ping, trimmed url, message for push", () => {
    assert.equal(monitorTarget({ type: "ping", hostname: " db.local " }), "db.local");
    assert.equal(monitorTarget({ type: "ping" }), "ICMP");
    assert.equal(monitorTarget({ type: "http", url: "https://a.test/" }), "a.test");
    assert.equal(monitorTarget({ type: "http", url: "https://", lastMessage: "OK" }), "OK");
    assert.equal(monitorTarget({ type: "push", lastMessage: null }), "—");
});

test("the summary sentence names the fleet state", () => {
    assert.equal(summarySentence(totals(), []).text, "All 33 monitors up");
    assert.equal(summarySentence(totals({ total: 0 }), []).text, "No monitors yet");
    const item = (monitorId, key) => ({ key, monitorId });
    const two = summarySentence(totals({ down: 1 }), [item(1, "a"), item(2, "b"), item(2, "c")]);
    assert.deepEqual(two, { text: "2 monitors need attention", tone: "bad" });
    assert.equal(summarySentence(totals(), [item(1, "a")]).text, "1 monitor needs attention");
    assert.equal(summarySentence(totals(), [item(null, "b")]).text, "1 item needs attention");
    assert.equal(summarySentence(totals({ total: 3, paused: 3 }), []).text, "All monitors are paused");
    assert.equal(summarySentence(totals({ maintenance: 2 }), []).tone, "maint");
});

test("ages and bucket text", () => {
    const now = Date.parse("2026-10-21T10:00:30Z");
    assert.equal(checkedAgo("2026-10-21 10:00:00", now), "30s ago");
    assert.equal(checkedAgo(null, now), "—");
    assert.equal(bucketSummary({ status: null, beats: 0, failed: 0 }), "No checks");
    assert.equal(bucketSummary({ status: 0, beats: 90, failed: 61 }), "Down · 90 checks, 61 failed");
    assert.equal(bucketSummary({ status: 1, beats: 1, failed: 0 }), "Up · 1 check");
});
