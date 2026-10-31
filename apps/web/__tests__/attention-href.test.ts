import { describe, expect, it } from "vitest";

import type { AttentionItem } from "@/lib/attention";
import { attentionHref } from "@/lib/attention-href";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
    key: "k",
    kind: "down",
    monitorId: 7,
    name: "api",
    title: "Down",
    detail: "for 5m",
    sinceMs: null,
    muted: false,
    ...over,
});

describe("attentionHref", () => {
    it("opens the monitor in the peek on Monitors", () => {
        expect(attentionHref(item({ monitorId: 7 }))).toBe("/monitors?m=7");
    });

    it("opens a backup problem on its agent's page", () => {
        expect(attentionHref(item({ kind: "backup", key: "backup:a1b2", monitorId: 4 }))).toBe("/backups/a1b2");
        expect(attentionHref(item({ kind: "backup", key: "backup:c3", monitorId: null }))).toBe("/backups/c3");
    });
});
