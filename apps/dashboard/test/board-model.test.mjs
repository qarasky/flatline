import test from "node:test";
import assert from "node:assert/strict";
import {
    EMPTY_FILTER,
    activeFilterCount,
    boardTotals,
    buildBoard,
    filterFacets,
    statusKeyOf,
    visibleRowIds,
    worstOf,
} from "../src/lib/board-model.ts";

let nextId = 1;
const mon = (name, extra = {}) => ({
    id: nextId++,
    name,
    type: "http",
    url: `https://${name}.test`,
    status: 1,
    active: true,
    ping: 10,
    lastCheck: null,
    lastMessage: null,
    interval: 60,
    uptime24h: 1,
    uptime7d: 1,
    uptime30d: 1,
    weight: 0,
    parent: null,
    ...extra,
});

function fleet() {
    nextId = 1;
    const work = mon("work", { type: "group", weight: 5 });
    const home = mon("home", { type: "group", weight: 9 });
    const sub = mon("sub", { type: "group", parent: work.id });
    return {
        work,
        home,
        sub,
        a: mon("alpha", { parent: work.id }),
        b: mon("bravo", { parent: work.id, status: 0, uptime24h: 0.5 }),
        c: mon("charlie", { parent: sub.id, status: 2, tags: [{ id: 1, name: "edge", color: "" }] }),
        d: mon("delta", { parent: home.id, type: "push" }),
        loose: mon("zulu"),
        paused: mon("yankee", { active: false, status: 0 }),
    };
}
const all = (f) => Object.values(f);
const names = (nodes) => nodes.map((n) => n.monitor.name);

test("status keys: paused beats status; unknown reads as pending", () => {
    assert.equal(statusKeyOf({ active: false, status: 0 }), "paused");
    assert.equal(statusKeyOf({ active: true, status: 0 }), "down");
    assert.equal(statusKeyOf({ active: true, status: 7 }), "pending");
    assert.equal(worstOf(["up", "paused", "pending"]), "pending");
    assert.equal(worstOf(["paused", "paused"]), "paused");
    assert.equal(worstOf([]), "up");
});

test("worst first: groups with a worse child rise, ties keep weight order", () => {
    const f = fleet();
    const board = buildBoard(all(f), { sort: "worst", filter: EMPTY_FILTER });
    // work holds a down monitor, home is all up even though its weight is higher
    assert.deepEqual(names(board.roots), ["work", "home"]);
    const work = board.roots[0];
    // inside work: the down monitor, then the subgroup (pending child) rises above the up monitor? ranks: bravo 0, sub 1, alpha 3
    assert.deepEqual(names(work.children), ["bravo", "sub", "alpha"]);
    assert.equal(work.worst, "down");
    assert.deepEqual(work.totals, { total: 3, up: 1, down: 1, pending: 1, maintenance: 0, paused: 0 });
    assert.deepEqual(names(board.ungrouped), ["zulu", "yankee"]);
});

test("all healthy: monitors sit before subgroups, weight then name, like the old board", () => {
    nextId = 1;
    const g = mon("g", { type: "group" });
    const sub = mon("sub", { type: "group", parent: g.id });
    const z = mon("zed", { parent: g.id, weight: 10 });
    const a = mon("able", { parent: g.id });
    const board = buildBoard([g, sub, z, a], { sort: "worst", filter: EMPTY_FILTER });
    assert.deepEqual(names(board.roots[0].children), ["zed", "able", "sub"]);
});

test("other sorts apply inside each group", () => {
    const f = fleet();
    const byName = buildBoard(all(f), { sort: "name", filter: EMPTY_FILTER });
    assert.deepEqual(names(byName.roots), ["home", "work"]);
    assert.deepEqual(names(byName.roots[1].children), ["alpha", "bravo", "sub"]);
    const byUptime = buildBoard(all(f), { sort: "uptime", filter: EMPTY_FILTER });
    assert.deepEqual(names(byUptime.roots[0].children), ["bravo", "alpha", "sub"]);
});

test("a held basis keeps the old order while rows show live data", () => {
    const f = fleet();
    const before = all(f);
    const basis = new Map(before.map((m) => [m.id, m]));
    const flipped = before.map((m) => (m.id === f.d.id ? { ...m, status: 0 } : m));
    const free = buildBoard(flipped, { sort: "worst", filter: EMPTY_FILTER });
    assert.deepEqual(names(free.roots), ["home", "work"]); // both down now: weight decides
    const held = buildBoard(flipped, { sort: "worst", filter: EMPTY_FILTER, basis });
    assert.deepEqual(names(held.roots), ["work", "home"]);
    assert.equal(held.roots[1].children[0].monitor.status, 0);
    assert.equal(held.roots[1].worst, "down");
});

test("filters: a group matches when any child matches; counts stay whole", () => {
    const f = fleet();
    const board = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, status: ["pending"] } });
    assert.deepEqual(names(board.roots), ["work"]);
    assert.deepEqual(names(board.roots[0].children), ["sub"]);
    assert.deepEqual(names(board.roots[0].children[0].children), ["charlie"]);
    assert.equal(board.roots[0].totals.total, 3);
    assert.deepEqual(board.ungrouped, []);

    const paused = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, status: ["paused"] } });
    assert.deepEqual(names(paused.ungrouped), ["yankee"]);
    assert.deepEqual(paused.roots, []);

    const typed = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, types: ["push"] } });
    assert.deepEqual(names(typed.roots), ["home"]);

    const tagged = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, tags: ["edge"] } });
    assert.deepEqual(names(tagged.roots), ["work"]);
});

test("needs-attention preset uses the supplied ids", () => {
    const f = fleet();
    const board = buildBoard(all(f), {
        sort: "worst",
        filter: { ...EMPTY_FILTER, attention: true },
        attentionIds: new Set([f.d.id]),
    });
    assert.deepEqual(names(board.roots), ["home"]);
    const none = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, attention: true } });
    assert.deepEqual(none.roots, []);
});

test("search matches name, url, type; a matching group name keeps its subtree", () => {
    const f = fleet();
    const byName = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, q: "BRAVO" } });
    assert.deepEqual(names(byName.roots[0].children), ["bravo"]);
    const byGroup = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, q: "work" } });
    // "work" matches the group name, so all three descendants stay
    assert.equal(byGroup.roots.length, 1);
    assert.equal(byGroup.roots[0].children.length, 3);
    const byUrl = buildBoard(all(f), { sort: "worst", filter: { ...EMPTY_FILTER, q: "zulu.test" } });
    assert.deepEqual(names(byUrl.ungrouped), ["zulu"]);
});

test("orphans land in ungrouped; a self-parent or cycle never hides a monitor", () => {
    nextId = 1;
    const orphan = mon("orphan", { parent: 999 });
    const selfish = mon("selfish", { type: "group" });
    selfish.parent = selfish.id;
    const board = buildBoard([orphan, selfish], { sort: "name", filter: EMPTY_FILTER });
    assert.deepEqual(names(board.ungrouped), ["orphan"]);
    assert.deepEqual(names(board.roots), ["selfish"]);
});

test("visible row ids honour collapse unless a filter forces groups open", () => {
    const f = fleet();
    const board = buildBoard(all(f), { sort: "worst", filter: EMPTY_FILTER });
    const collapsed = new Set([f.work.id]);
    const ids = visibleRowIds(board, collapsed, false).map((r) => r.id);
    assert.ok(ids.includes(f.work.id) && !ids.includes(f.b.id));
    assert.ok(visibleRowIds(board, collapsed, true).some((r) => r.id === f.b.id));
});

test("totals skip groups; facets list types and tags; badge counts filters but not search", () => {
    const f = fleet();
    assert.deepEqual(boardTotals(all(f)), { total: 6, up: 3, down: 1, pending: 1, maintenance: 0, paused: 1 });
    assert.deepEqual(filterFacets(all(f)), { types: ["http", "push"], tags: ["edge"] });
    assert.equal(activeFilterCount({ q: "x", status: ["down"], types: ["http"], tags: [], attention: true }), 3);
});
