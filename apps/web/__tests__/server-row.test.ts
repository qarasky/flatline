import { describe, expect, it } from "vitest";

import type { MonitorSummary } from "@/lib/monitor-types";
import { serverRow } from "@/lib/server-row";

const now = Date.parse("2026-10-31T10:00:00Z");
const server = { id: 1, name: "db-01", type: "push", interval: 60 } as MonitorSummary;
const sample = (secondsAgo: number, over: Record<string, unknown> = {}) => ({
    time: new Date(now - secondsAgo * 1000).toISOString(),
    metrics: {
        sampleInterval: 10,
        cpu: { percent: 12.5 },
        mem: { percent: 40 },
        disk: [
            { mount: "/", percent: 30 },
            { mount: "/data", percent: 91 },
        ],
        agent: { version: "1.8.2" },
        ...over,
    },
});

describe("serverRow", () => {
    it("has nothing to show before the first sample", () => {
        expect(serverRow(server, undefined, now)).toEqual({
            cpu: null,
            ram: null,
            disk: null,
            agentVersion: null,
            freshness: "none",
            ageText: "No metrics yet",
        });
    });

    it("reads a fresh sample, with the fullest mount as the disk", () => {
        const row = serverRow(server, sample(5), now);
        expect(row).toMatchObject({ cpu: 12.5, ram: 40, disk: 91, agentVersion: "1.8.2", freshness: "fresh" });
        expect(row.ageText).toBe("updated 5s ago");
    });

    it("calls a sample older than three intervals stale", () => {
        const row = serverRow(server, sample(45), now);
        expect(row.freshness).toBe("stale");
        expect(row.ageText).toBe("Stale: last sample 45s ago");
    });

    it("leaves out a disk list that is empty", () => {
        expect(serverRow(server, sample(5, { disk: [] }), now).disk).toBeNull();
    });
});
