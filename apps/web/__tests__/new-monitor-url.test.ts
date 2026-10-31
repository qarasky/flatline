import { describe, expect, it } from "vitest";

import { parseBoardQuery } from "@/lib/board-url";
import { newMonitorPresets, withNewMonitorParams } from "@/lib/new-monitor-url";

describe("the create dialog's URL keys", () => {
    it("opening it keeps the board's own type filter", () => {
        expect(withNewMonitorParams("?type=http&status=down", {})).toBe("?type=http&status=down&new=1");
    });

    it("a new subgroup asks with its own key, not the type filter's", () => {
        const search = withNewMonitorParams("?type=http", { parent: 5, type: "group" });
        const params = new URLSearchParams(search);
        expect(params.get("type")).toBe("http");
        expect(params.get("newType")).toBe("group");
        expect(params.get("parent")).toBe("5");
    });

    it("closing it takes only its own keys out", () => {
        expect(withNewMonitorParams("?type=http&new=1&newType=group&parent=5", null)).toBe("?type=http");
    });

    it("reads the presets back", () => {
        expect(newMonitorPresets(new URLSearchParams("?new=1&newType=group&parent=5"))).toEqual({
            parent: 5,
            type: "group",
        });
        expect(newMonitorPresets(new URLSearchParams("?type=group"))).toBeNull();
    });

    it("a new-subgroup link does not filter the board to groups", () => {
        expect(parseBoardQuery("?new=1&newType=group&parent=5").filter.types).toEqual([]);
    });
});
