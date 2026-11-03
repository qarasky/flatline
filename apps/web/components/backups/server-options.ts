import type { SelectOption } from "@qarasky/kore-ui";

import type { MonitorSummary } from "@/lib/monitor-types";

/** Radix Select cannot hold an empty value, so "not linked" is this sentinel. */
export const NOT_LINKED = "none";

/** The Server choices for a backup agent: "Not linked", then every push monitor. */
export function serverOptions(monitors: MonitorSummary[]): SelectOption[] {
    return [
        { value: NOT_LINKED, label: "Not linked" },
        ...monitors.filter((m) => m.type === "push").map((m) => ({ value: String(m.id), label: m.name })),
    ];
}

/** The monitor id a Server choice stands for, or null for "Not linked". */
export function serverId(value: string): number | null {
    return value === NOT_LINKED ? null : Number(value);
}
