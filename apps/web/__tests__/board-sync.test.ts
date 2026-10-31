import { describe, expect, it } from "vitest";

import { urlBoardChange } from "@/lib/board-sync";

describe("urlBoardChange", () => {
    it("ignores the board's own write", () => {
        expect(urlBoardChange("?status=down&m=5", "?status=down&m=5")).toBeNull();
    });

    it("ignores keys that are not board state", () => {
        expect(urlBoardChange("?status=down&new=1", "?status=down")).toBeNull();
    });

    it("ignores the same state written in another order", () => {
        expect(urlBoardChange("?m=5&status=down", "?status=down&m=5")).toBeNull();
    });

    it("re-seeds from a navigation to the plain list", () => {
        const change = urlBoardChange("", "?status=down&m=5");
        expect(change?.filter.status).toEqual([]);
        expect(change?.open).toBeNull();
    });

    it("re-seeds from a link with other filters", () => {
        expect(urlBoardChange("?status=pending", "?status=down")?.filter.status).toEqual(["pending"]);
    });
});
