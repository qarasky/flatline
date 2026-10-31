/**
 * The Monitors keyboard, as pure decisions (the listener lives in the board).
 *
 * | Key       | Action                                                       |
 * | --------- | ------------------------------------------------------------ |
 * | `/`       | Focus search                                                 |
 * | `j` / `k` | Move down / up the rows                                      |
 * | `Enter`   | Open the monitor (toggle a group)                            |
 * | `x`       | Select the row for bulk actions                              |
 * | `Esc`     | Close the peek, then clear the selection, then the filters  |
 *
 * Shortcuts never fire while typing in a field, and an open dialog or menu
 * handles its own keys (Esc closes it, nothing else).
 */

export type BoardKeyAction = "focusSearch" | "down" | "up" | "open" | "select" | "escape" | "leaveField";

/** Where the key was pressed: a text field, a checkbox, a button or link, or anywhere else. */
export type KeyTarget = "text" | "checkbox" | "control" | "other";

export function boardKey(e: {
    key: string;
    target: KeyTarget;
    overlayOpen: boolean;
    modifier: boolean;
}): BoardKeyAction | null {
    if (e.modifier || e.overlayOpen) {
        return null;
    }
    if (e.target === "text") {
        return e.key === "Escape" ? "leaveField" : null;
    }
    switch (e.key) {
        case "/":
            return "focusSearch";
        case "j":
            return "down";
        case "k":
            return "up";
        case "x":
            return "select";
        case "Escape":
            return "escape";
        case "Enter":
            // A focused button or link acts on Enter itself.
            return e.target === "control" ? null : "open";
        default:
            return null;
    }
}

/** The next row for `j` (1) or `k` (-1), clamped at the ends; from nowhere, the first or last row. */
export function moveCursor(rows: number[], current: number | null, delta: 1 | -1): number | null {
    if (rows.length === 0) {
        return null;
    }
    const at = current === null ? -1 : rows.indexOf(current);
    if (at < 0) {
        return delta === 1 || current !== null ? rows[0] : rows[rows.length - 1];
    }
    return rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
}

/** What one Esc undoes, most recent layer first. */
export function escapeStep(s: {
    peekOpen: boolean;
    selected: number;
    filterActive: boolean;
}): "closePeek" | "clearSelection" | "clearFilters" | null {
    if (s.peekOpen) {
        return "closePeek";
    }
    if (s.selected > 0) {
        return "clearSelection";
    }
    return s.filterActive ? "clearFilters" : null;
}
