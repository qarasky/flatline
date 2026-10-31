import { test } from "vitest";
import assert from "node:assert/strict";
import { liveHubState, onLiveResync, subscribeLive } from "@/lib/live-hub";
import { prependBeat } from "@/lib/heartbeat-log";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const encode = (value) => new TextEncoder().encode(value);

test("views share one stream; metrics upgrade reopens it; last leaver closes it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.window = {};
    globalThis.document = { hidden: false };
    const opened = [];
    globalThis.fetch = async (url, init) => {
        let controller;
        const entry = { url, aborted: false, send: (frame) => controller.enqueue(encode(frame)) };
        opened.push(entry);
        init.signal.addEventListener("abort", () => {
            entry.aborted = true;
            controller.error(new Error("aborted"));
        });
        return new Response(
            new ReadableStream({
                start(c) {
                    controller = c;
                },
            }),
            { headers: { "Content-Type": "text/event-stream" } }
        );
    };

    const log = { a: [], b: [], c: [] };
    const snapshots = { a: 0, b: 0, c: 0 };
    const readies = { a: 0, b: 0, c: 0 };
    const backups = { a: 0, b: 0, c: 0 };
    const make = (name, metrics) => ({
        metrics,
        snapshot: async () => {
            snapshots[name]++;
        },
        ready: () => readies[name]++,
        backups: () => backups[name]++,
        event: (e) => log[name].push(e),
        error: () => {},
    });
    let resyncs = 0;
    const stopResync = onLiveResync(() => resyncs++);
    const leave = [];
    try {
        leave.push(subscribeLive(make("a", false)));
        await tick(0);
        assert.equal(opened.length, 1);
        assert.equal(opened[0].url, "/api/v1/events?metrics=0");
        opened[0].send('data: {"type":"ready"}\n\n');
        await tick();
        assert.equal(snapshots.a, 1);
        assert.equal(resyncs, 1);

        // A second metrics-free view joins the open stream: no new fetch,
        // but its own snapshot runs once.
        leave.push(subscribeLive(make("b", false)));
        await tick();
        assert.equal(opened.length, 1);
        assert.equal(snapshots.b, 1);

        opened[0].send('data: {"type":"heartbeat","monitorId":7,"patch":{"status":1}}\n\n');
        await tick();
        assert.equal(log.a.length, 1);
        assert.equal(log.b.length, 1);

        // A view that needs metrics forces a reopen with metrics on.
        leave.push(subscribeLive(make("c", true)));
        await tick(0);
        assert.equal(opened[0].aborted, true);
        assert.equal(opened.length, 2);
        assert.equal(opened[1].url, "/api/v1/events");
        opened[1].send('data: {"type":"ready"}\n\n');
        await tick();
        assert.deepEqual(snapshots, { a: 2, b: 2, c: 1 });
        // `ready` and `backups` fan out to every subscriber.
        assert.deepEqual(readies, { a: 2, b: 1, c: 1 });
        opened[1].send('data: {"type":"backups"}\n\n');
        await tick();
        assert.deepEqual(backups, { a: 1, b: 1, c: 1 });

        // Metrics events reach only the subscriber that asked for them.
        opened[1].send('data: {"type":"metrics","monitorId":7,"time":"t","metrics":{}}\n\n');
        await tick();
        assert.equal(log.c.length, 1);
        assert.equal(log.a.length, 1);
        assert.deepEqual(liveHubState(), { subscribers: 3, open: true, metrics: true });

        leave.forEach((fn) => fn());
        assert.equal(opened[1].aborted, true);
        assert.equal(liveHubState().open, false);
    } finally {
        leave.forEach((fn) => fn());
        stopResync();
        globalThis.fetch = originalFetch;
        delete globalThis.window;
        delete globalThis.document;
    }
});

test("live beats are prepended locally, deduplicated and capped", () => {
    const beats = [
        { time: "2026-10-20 10:00:00", status: 1, ping: 10, msg: "", important: false },
        { time: "2026-10-20 09:59:00", status: 1, ping: 12, msg: "", important: false },
    ];
    const next = prependBeat(
        beats,
        { status: 0, ping: null, lastCheck: "2026-10-20 10:01:00", lastMessage: "timeout" },
        2
    );
    assert.equal(next.added, true);
    assert.equal(next.beats.length, 2);
    assert.deepEqual(next.beats[0], {
        time: "2026-10-20 10:01:00",
        status: 0,
        ping: null,
        msg: "timeout",
        important: true,
    });
    assert.equal(next.beats[1].time, "2026-10-20 10:00:00");

    // The snapshot already had this beat: no duplicate.
    const again = prependBeat(next.beats, { status: 0, lastCheck: "2026-10-20 10:01:00" }, 2);
    assert.equal(again.added, false);
    assert.equal(again.beats, next.beats);

    // A patch that is not a beat (no time) changes nothing.
    assert.equal(prependBeat(beats, { status: 1 }, 120).added, false);
    assert.equal(prependBeat([], { status: 1, lastCheck: "x" }, 120).beats[0].important, true);
});
