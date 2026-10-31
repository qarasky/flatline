import { describe, expect, it } from "vitest";

import { buildMonitorPayload } from "@/lib/monitor-payload";

describe("buildMonitorPayload", () => {
    it("drops empty fields and always sends type, thresholds and provider", () => {
        expect(buildMonitorPayload("http", { name: "api", url: "", metricCpuThreshold: 90 })).toEqual({
            type: "http",
            name: "api",
            metricCpuThreshold: 90,
            metricRamThreshold: null,
            metricDiskThreshold: null,
            provider: null,
        });
    });

    it("trims and lowercases the provider", () => {
        expect(buildMonitorPayload("push", { name: "db", provider: "  Hetzner " }).provider).toBe("hetzner");
    });

    it("sends exactly the notifications given", () => {
        expect(buildMonitorPayload("http", { name: "api" }, [3, 1]).notificationIDList).toEqual([3, 1]);
    });

    it("leaves notifications alone when they were not loaded", () => {
        expect(buildMonitorPayload("http", { name: "api" })).not.toHaveProperty("notificationIDList");
    });

    it("keeps a null parent, which takes the monitor out of its group", () => {
        expect(buildMonitorPayload("http", { name: "api", parent: null }).parent).toBeNull();
    });

    it("drops undefined values", () => {
        expect(buildMonitorPayload("http", { name: "api", keyword: undefined })).not.toHaveProperty("keyword");
    });

    it("does not echo the read-only notificationIds back", () => {
        expect(buildMonitorPayload("http", { name: "api", notificationIds: [1] }, [2])).not.toHaveProperty(
            "notificationIds"
        );
    });
});
