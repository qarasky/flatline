import type { MonitorSummary } from "@/lib/monitor-types";

/** Create presets: the group to create in, and whether it is a group. */
export type NewMonitorPresets = Partial<Pick<MonitorSummary, "parent" | "type">>;

/**
 * The create dialog's own query keys. `newType`, not `type`: the board's
 * type filter already uses `type`, and the two must not meet.
 */
export const NEW_KEYS = ["new", "parent", "newType"] as const;

/** The presets `?new=1&parent=ID&newType=group` ask for, or null when the dialog is closed. */
export function newMonitorPresets(params: URLSearchParams): NewMonitorPresets | null {
    if (params.get("new") !== "1") {
        return null;
    }
    const presets: NewMonitorPresets = {};
    const parent = Number(params.get("parent"));
    if (Number.isSafeInteger(parent) && parent > 0) {
        presets.parent = parent;
    }
    if (params.get("newType") === "group") {
        presets.type = "group";
    }
    return presets;
}

/** `search` with the dialog opened (with `presets`) or closed (null); every other key is kept. */
export function withNewMonitorParams(search: string, presets: NewMonitorPresets | null): string {
    const params = new URLSearchParams(search);
    for (const key of NEW_KEYS) {
        params.delete(key);
    }
    if (presets) {
        params.set("new", "1");
        if (typeof presets.parent === "number") {
            params.set("parent", String(presets.parent));
        }
        if (presets.type === "group") {
            params.set("newType", "group");
        }
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}
