import test from "node:test";
import assert from "node:assert/strict";
import { historyPath, historyRefreshMs, historyTimeoutMs } from "../src/lib/history-chart.ts";

test("history charts preserve gaps instead of plotting missing samples as zero", () => {
    const from = "2026-10-09T00:00:00Z",
        to = "2026-10-09T01:00:00Z";
    const point = (minute, cpu) => ({
        time: new Date(Date.parse(from) + minute * 60_000).toISOString(),
        cpu,
        ram: null,
        gpu: null,
        vram: null,
    });
    const path = historyPath(
        [point(0, 0), point(0.5, 10), point(1, null), point(1.5, 20), point(20, 30)],
        "cpu",
        from,
        to,
        30
    );
    assert.equal((path.match(/M/g) || []).length, 3);
    assert.equal((path.match(/L/g) || []).length, 1);
    assert.ok(!path.includes("NaN"));
    assert.equal(historyPath([], "cpu", from, to, 30), "");
});

test("long history ranges refresh rarely and every request has a deadline", () => {
    assert.equal(historyRefreshMs(1 / 6), 30_000);
    assert.equal(historyRefreshMs(1), 30_000);
    assert.equal(historyRefreshMs(24), 60_000);
    assert.equal(historyRefreshMs(168), 300_000);
    assert.equal(historyRefreshMs(720), 900_000);
    assert.equal(historyRefreshMs(8760), 900_000);
    for (const hours of [1, 24, 168, 8760]) {
        assert.ok(historyTimeoutMs(hours) > 0 && historyTimeoutMs(hours) < historyRefreshMs(hours) + 60_000);
    }
});
