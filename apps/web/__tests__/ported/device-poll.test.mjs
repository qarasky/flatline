import { test } from "vitest";
import assert from "node:assert/strict";
import { POLL_INTERVAL_MS, runDeviceSignIn } from "@/lib/device-poll";

/**
 * Build fakes for runDeviceSignIn. `polls` is the script of poll answers per
 * started request; an Error entry makes that poll throw.
 */
function setup({ polls, abortAfterPolls = Infinity }) {
    const controller = new AbortController();
    const log = { starts: 0, polls: [], waits: [], codes: [], statuses: [] };
    let clock = 0;
    const queue = polls.map((script) => [...script]);

    const deps = {
        origin: "http://tv.local",
        signal: controller.signal,
        now: () => clock,
        start: async () => {
            log.starts += 1;
            return { code: `code${log.starts}`, pollSecret: `secret${log.starts}`, expiresIn: 300, publicUrl: null };
        },
        poll: async (code, secret) => {
            log.polls.push([code, secret]);
            if (log.polls.length >= abortAfterPolls) {
                controller.abort();
            }
            const next = queue[log.starts - 1].shift();
            if (next instanceof Error) {
                throw next;
            }
            return next;
        },
        wait: async (ms) => {
            log.waits.push(ms);
            clock += ms;
        },
        onCode: (c) => log.codes.push(c),
        onStatus: (s) => log.statuses.push(s),
    };
    return { deps, log };
}

test("delivers the token when approved", async () => {
    const { deps, log } = setup({
        polls: [[{ status: "pending" }, { status: "approved", token: "flatline_op_x" }]],
    });
    const token = await runDeviceSignIn(deps);
    assert.equal(token, "flatline_op_x");
    assert.equal(log.starts, 1);
    assert.deepEqual(log.polls[0], ["code1", "secret1"]);
    assert.equal(log.codes[0].url, "http://tv.local/device#code1");
});

test("starts a new request after expired", async () => {
    const { deps, log } = setup({
        polls: [[{ status: "expired" }], [{ status: "approved", token: "t2" }]],
    });
    assert.equal(await runDeviceSignIn(deps), "t2");
    assert.equal(log.starts, 2);
    assert.deepEqual(log.polls[1], ["code2", "secret2"]);
});

test("starts a new request after denied and reports it", async () => {
    const { deps, log } = setup({
        polls: [[{ status: "denied" }], [{ status: "approved", token: "t2" }]],
    });
    assert.equal(await runDeviceSignIn(deps), "t2");
    assert.equal(log.starts, 2);
    assert.ok(log.statuses.includes("denied"));
});

test("retries the same code after a network error", async () => {
    const { deps, log } = setup({
        polls: [[new Error("offline"), { status: "pending" }, { status: "approved", token: "t" }]],
    });
    assert.equal(await runDeviceSignIn(deps), "t");
    assert.equal(log.starts, 1, "a blip must not discard the request");
    assert.ok(log.statuses.includes("error"));
    assert.equal(log.statuses.at(-1), "waiting", "recovery clears the error");
});

test("stops without further calls after abort", async () => {
    const { deps, log } = setup({
        polls: [[{ status: "pending" }, { status: "pending" }, { status: "approved", token: "t" }]],
        abortAfterPolls: 1,
    });
    assert.equal(await runDeviceSignIn(deps), null);
    assert.equal(log.polls.length, 1);
    assert.equal(log.starts, 1);
});

test("never polls faster than the interval", async () => {
    const { deps, log } = setup({
        polls: [[{ status: "pending" }, { status: "pending" }, { status: "approved", token: "t" }]],
    });
    await runDeviceSignIn(deps);
    assert.equal(POLL_INTERVAL_MS, 2000);
    assert.equal(log.waits.length, log.polls.length);
    assert.ok(log.waits.every((ms) => ms >= POLL_INTERVAL_MS));
});

import { abortableWait } from "@/lib/device-poll";

/** A signal stand-in that counts live listeners. */
function countingSignal(aborted = false) {
    const listeners = new Set();
    return {
        aborted,
        listeners,
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
    };
}

test("abortableWait leaves no abort listener behind once the timer fires", async () => {
    const signal = countingSignal();
    await abortableWait(1, signal);
    assert.equal(signal.listeners.size, 0);
});

test("abortableWait resolves at once for a signal that is already aborted", async () => {
    const signal = countingSignal(true);
    const started = Date.now();
    await abortableWait(5000, signal);
    assert.ok(Date.now() - started < 500);
});
