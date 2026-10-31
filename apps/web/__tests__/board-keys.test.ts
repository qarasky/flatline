import { describe, expect, it } from "vitest";

import { boardKey, escapeStep, moveCursor } from "@/lib/board-keys";

const key = (k: string, over: Partial<Parameters<typeof boardKey>[0]> = {}) =>
    boardKey({ key: k, target: "other", overlayOpen: false, modifier: false, ...over });

describe("boardKey", () => {
    it("never moves while typing in a field", () => {
        expect(key("j", { target: "text" })).toBeNull();
        expect(key("x", { target: "text" })).toBeNull();
        expect(key("/", { target: "text" })).toBeNull();
        expect(key("Enter", { target: "text" })).toBeNull();
    });

    it("still works on a checkbox, which is not text entry", () => {
        expect(key("j", { target: "checkbox" })).toBe("down");
    });

    it("maps the board keys", () => {
        expect(key("/")).toBe("focusSearch");
        expect(key("j")).toBe("down");
        expect(key("k")).toBe("up");
        expect(key("x")).toBe("select");
        expect(key("Enter")).toBe("open");
        expect(key("Escape")).toBe("escape");
    });

    it("leaves Escape to an open dialog or menu", () => {
        expect(key("Escape", { overlayOpen: true })).toBeNull();
        expect(key("j", { overlayOpen: true })).toBeNull();
    });

    it("ignores keys with a modifier (browser and palette shortcuts)", () => {
        expect(key("j", { modifier: true })).toBeNull();
        expect(key("k", { modifier: true })).toBeNull();
    });

    it("lets Escape leave a text field", () => {
        expect(key("Escape", { target: "text" })).toBe("leaveField");
    });

    it("leaves Enter to buttons and links, which act on it themselves", () => {
        expect(key("Enter", { target: "control" })).toBeNull();
        expect(key("j", { target: "control" })).toBe("down");
    });
});

describe("moveCursor", () => {
    it("starts at the first row going down and the last going up", () => {
        expect(moveCursor([4, 7, 9], null, 1)).toBe(4);
        expect(moveCursor([4, 7, 9], null, -1)).toBe(9);
    });

    it("moves and clamps at the ends", () => {
        expect(moveCursor([4, 7, 9], 4, 1)).toBe(7);
        expect(moveCursor([4, 7, 9], 9, 1)).toBe(9);
        expect(moveCursor([4, 7, 9], 4, -1)).toBe(4);
    });

    it("restarts from the top when the cursor row is gone", () => {
        expect(moveCursor([4, 7, 9], 5, 1)).toBe(4);
    });

    it("has nowhere to go in an empty list", () => {
        expect(moveCursor([], null, 1)).toBeNull();
    });
});

describe("escapeStep", () => {
    it("closes the peek first, then clears the selection, then the filters", () => {
        expect(escapeStep({ peekOpen: true, selected: 2, filterActive: true })).toBe("closePeek");
        expect(escapeStep({ peekOpen: false, selected: 2, filterActive: true })).toBe("clearSelection");
        expect(escapeStep({ peekOpen: false, selected: 0, filterActive: true })).toBe("clearFilters");
        expect(escapeStep({ peekOpen: false, selected: 0, filterActive: false })).toBeNull();
    });
});
