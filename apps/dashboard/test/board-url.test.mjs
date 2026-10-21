import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_FILTER } from "../src/lib/board-model.ts";
import {
    addView,
    loadDensity,
    loadViews,
    parseBoardQuery,
    removeView,
    serializeBoardQuery,
    setDefaultView,
    storeViews,
} from "../src/lib/board-url.ts";

const memory = (seed = {}) => {
    const data = { ...seed };
    return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), data };
};

test("a plain board has no query", () => {
    assert.equal(serializeBoardQuery({ filter: EMPTY_FILTER, sort: "worst", open: null }), "");
    const parsed = parseBoardQuery("");
    assert.equal(parsed.hasParams, false);
    assert.equal(parsed.sort, "worst");
});

test("filters, sort and the open monitor survive a round trip", () => {
    const query = {
        filter: { q: "api & co", status: ["down", "pending"], types: ["http"], tags: ["edge"], attention: true },
        sort: "uptime",
        open: 12,
    };
    const search = serializeBoardQuery(query);
    const back = parseBoardQuery(search);
    assert.deepEqual({ filter: back.filter, sort: back.sort, open: back.open }, query);
    assert.equal(back.hasParams, true);
});

test("unknown values are ignored and foreign params are kept", () => {
    const back = parseBoardQuery("?status=down,bogus&sort=nope&m=abc&utm=1");
    assert.deepEqual(back.filter.status, ["down"]);
    assert.equal(back.sort, "worst");
    assert.equal(back.open, null);
    const out = serializeBoardQuery({ filter: EMPTY_FILTER, sort: "name", open: null }, "?utm=1&q=old");
    assert.equal(out, "?utm=1&sort=name");
});

test("saved views persist, replace by name, delete and keep one default", () => {
    const storage = memory();
    let state = loadViews(storage);
    assert.deepEqual(state, { views: [], defaultId: null });
    state = addView(state, "  Down now ", { ...EMPTY_FILTER, status: ["down"] }, "worst");
    state = addView(state, "By name", EMPTY_FILTER, "name");
    assert.equal(state.views.length, 2);
    state = addView(state, "down NOW", { ...EMPTY_FILTER, status: ["pending"] }, "worst");
    assert.equal(state.views.length, 2);
    assert.deepEqual(state.views[0].filter.status, ["pending"]);
    state = setDefaultView(state, state.views[1].id);
    storeViews(storage, state);
    const loaded = loadViews(storage);
    assert.deepEqual(loaded, state);
    assert.equal(loaded.views[1].sort, "name");
    const removed = removeView(loaded, loaded.views[1].id);
    assert.equal(removed.defaultId, null);
    assert.equal(removed.views.length, 1);
    assert.equal(setDefaultView(removed, "missing").defaultId, null);
    assert.equal(addView(state, "   ", EMPTY_FILTER, "worst"), state);
});

test("corrupt storage falls back to empty; density defaults to comfortable", () => {
    assert.deepEqual(loadViews(memory({ "flatline.board.views": "{nope" })), { views: [], defaultId: null });
    assert.equal(loadDensity(memory()), "comfortable");
    assert.equal(loadDensity(memory({ "flatline.board.density": "compact" })), "compact");
});
