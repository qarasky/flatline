import test from "node:test";
import assert from "node:assert/strict";
import { serialRefresh } from "../src/lib/serial-refresh.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a burst of triggers runs once now and once after, never overlapping", async () => {
    let running = 0;
    let peak = 0;
    let runs = 0;
    const refresh = serialRefresh(async () => {
        runs++;
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
    });

    // Upload progress: a backups event every few ms while the first fetch runs.
    const all = [refresh(), refresh(), refresh(), refresh(), refresh()];
    await Promise.all(all);
    assert.equal(peak, 1, "fetches never overlap, so an older response can't overwrite a newer one");
    assert.equal(runs, 2, "the burst collapses to the running fetch plus one that sees the latest state");
});

test("a trigger after everything settled runs again", async () => {
    let runs = 0;
    const refresh = serialRefresh(async () => {
        runs++;
        await tick();
    });
    await refresh();
    await refresh();
    assert.equal(runs, 2);
});

test("a failing run does not wedge later refreshes", async () => {
    let runs = 0;
    const refresh = serialRefresh(async () => {
        runs++;
        if (runs === 1) {
            throw new Error("network");
        }
    });
    await refresh().catch(() => {});
    await refresh();
    assert.equal(runs, 2);
});
