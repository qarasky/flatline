import test from "node:test";
import assert from "node:assert/strict";
import { getToken, setToken } from "../src/lib/api.ts";

/**
 * A localStorage whose methods always throw, like a browser that blocks
 * storage (private mode, disabled third-party storage, quota/security
 * errors).
 * @returns {object} Throwing storage stub
 */
function blockedStorage() {
    const thrower = () => {
        throw new Error("storage is blocked");
    };
    return { getItem: thrower, setItem: thrower, removeItem: thrower };
}

test("a token set while storage is blocked still authenticates the session", async () => {
    // The audit's reproduction: setToken swallowed the storage error with a
    // comment promising the session keeps working, but getToken() then threw
    // and returned null, so every later request was unauthenticated.
    const originalWindow = globalThis.window;
    globalThis.window = { localStorage: blockedStorage() };
    try {
        setToken("session-token");
        assert.equal(getToken(), "session-token", "the in-memory copy must serve the session");
    } finally {
        globalThis.window = originalWindow;
    }
});

test("logout clears the in-memory copy too", async () => {
    const originalWindow = globalThis.window;
    const store = new Map();
    globalThis.window = {
        localStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, value),
            removeItem: (key) => store.delete(key),
        },
    };
    try {
        setToken("persisted-token");
        assert.equal(getToken(), "persisted-token");
        assert.equal(store.get("flatline.token"), "persisted-token", "storage is the persistence layer");

        setToken(null);
        assert.equal(getToken(), null, "logging out must not leave a session copy behind");
        assert.equal(store.has("flatline.token"), false, "storage is cleared as well");
    } finally {
        globalThis.window = originalWindow;
    }
});

test("a token in storage keeps working without setToken in this tab", async () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
        localStorage: { getItem: () => "from-another-tab", setItem: () => {}, removeItem: () => {} },
    };
    try {
        assert.equal(getToken(), "from-another-tab");
    } finally {
        globalThis.window = originalWindow;
    }
});
