import { test } from "vitest";
import assert from "node:assert/strict";
import { buildLinkCandidates, isWebsiteMonitor } from "@/lib/links";

/** Minimal roster: two groups, a mix of servers, websites and a ping check. */
const roster = [
    { id: 1, name: "Work", type: "group", status: 1 },
    { id: 2, name: "edge-01", type: "push", parent: 1, status: 1 },
    { id: 3, name: "shop", type: "https", parent: 1, status: 1 },
    { id: 4, name: "blog", type: "http", parent: 1, status: 0 },
    { id: 5, name: "Servers", type: "group", status: 1 },
    { id: 6, name: "db-01", type: "push", parent: 5, status: 1 },
    { id: 7, name: "gateway", type: "ping", status: 1 },
    { id: 8, name: "nested", type: "group", parent: 1, status: 1 },
    { id: 9, name: "deep", type: "http", parent: 8, status: 2 },
];

test("only websites count as linkable monitors", () => {
    assert.equal(isWebsiteMonitor({ type: "http" }), true);
    assert.equal(isWebsiteMonitor({ type: "https" }), true);
    for (const type of ["push", "ping", "group"]) {
        assert.equal(isWebsiteMonitor({ type }), false, `${type} is not a website`);
    }
});

test("the picker offers websites and the groups holding one", () => {
    const candidates = buildLinkCandidates(roster, 2);
    // Groups first (path-sorted, nested last), then websites by label. The
    // "Servers" group holds only a server, so it is not offered; nor are the
    // server (2, also the excluded one), db-01 or the ping check.
    assert.deepEqual(
        candidates.map((candidate) => [candidate.id, candidate.kind]),
        [
            [1, "group"],
            [8, "group"],
            [4, "monitor"],
            [9, "monitor"],
            [3, "monitor"],
        ]
    );
    assert.deepEqual(
        candidates.map((candidate) => candidate.label),
        ["Work", "Work / nested", "blog", "deep", "shop"]
    );
});

test("a group holding a website only in a nested group is still offered", () => {
    const nested = [
        ...roster,
        { id: 10, name: "Deep", type: "group", status: 1 },
        { id: 11, name: "Deeper", type: "group", parent: 10, status: 1 },
        { id: 12, name: "buried", type: "http", parent: 11, status: 1 },
    ];
    const groupIds = buildLinkCandidates(nested, null)
        .filter((candidate) => candidate.kind === "group")
        .map((candidate) => candidate.id);
    assert.deepEqual(groupIds, [10, 11, 1, 8]);
});

test("the server being edited is never offered as its own link", () => {
    const server = { id: 3, name: "shop", type: "https", status: 1 };
    const candidates = buildLinkCandidates([...roster, server], 3);
    assert.ok(!candidates.some((candidate) => candidate.id === 3));
});
