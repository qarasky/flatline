import type { StatusKey } from "@/lib/board-model";
import type { MonitorSummary } from "@/lib/monitor-types";
import { isCovered } from "@/lib/mute";

export type RowMenuId =
    "open" | "edit" | "rename" | "move" | "mute" | "unmute" | "pause" | "resume" | "newSubgroup" | "delete";

/** Mute while down, Unmute while a mute covers it, neither otherwise. */
function muteItem(subject: MonitorSummary, down: boolean): RowMenuId[] {
    if (isCovered(subject)) {
        return ["unmute"];
    }
    return down ? ["mute"] : [];
}

/** A monitor row's `⋯` and right-click menu, in order. */
export function monitorMenuItems(m: MonitorSummary): RowMenuId[] {
    return [
        "open",
        "edit",
        "rename",
        "move",
        ...muteItem(m, m.active && m.status === 0),
        m.active ? "pause" : "resume",
        "delete",
    ];
}

/** A group row's menu; `worst` is the group's worst-of status from the board. */
export function groupMenuItems(g: MonitorSummary, worst: StatusKey): RowMenuId[] {
    return ["open", "edit", "newSubgroup", "rename", "move", ...muteItem(g, worst === "down"), "delete"];
}

export const ROW_MENU_LABEL: Record<RowMenuId, string> = {
    open: "Open",
    edit: "Edit…",
    rename: "Rename…",
    move: "Move to group…",
    mute: "Mute",
    unmute: "Unmute",
    pause: "Pause",
    resume: "Resume",
    newSubgroup: "New subgroup…",
    delete: "Delete…",
};
