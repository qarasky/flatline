"use client";

import { ChevronRight } from "lucide-react";
import { memo, type CSSProperties } from "react";

import { STATUS_LABEL } from "@/lib/board-format";
import type { GroupNode } from "@/lib/board-model";
import { isCovered } from "@/lib/mute";
import { groupMenuItems } from "@/lib/row-menu";
import { cn } from "@/lib/utils";

import { useBoardActions } from "./board-context";
import { RowContextMenu, RowMenuButton } from "./row-menu";
import { StatusDot } from "./status-dot";

/** Up / down counts that still tell the truth when the group is collapsed. */
function Counts({ totals }: { totals: GroupNode["totals"] }) {
    const parts: { text: string; tone: string }[] = [];
    if (totals.down > 0) {
        parts.push({ text: `${totals.down} down`, tone: "text-status-down font-medium" });
    }
    if (totals.pending > 0) {
        parts.push({ text: `${totals.pending} pending`, tone: "text-status-warn font-medium" });
    }
    if (totals.maintenance > 0) {
        parts.push({ text: `${totals.maintenance} maintenance`, tone: "text-status-maint" });
    }
    parts.push({ text: `${totals.up} up`, tone: "text-muted-foreground" });
    if (totals.paused > 0) {
        parts.push({ text: `${totals.paused} paused`, tone: "text-muted-foreground" });
    }
    return (
        <span className="flex shrink-0 justify-end gap-x-2 text-xs whitespace-nowrap tabular-nums">
            {parts.map((part) => (
                <span key={part.text} className={part.tone}>
                    {part.text}
                </span>
            ))}
        </span>
    );
}

const SEGMENTS: { key: keyof GroupNode["totals"]; color: string; label: string }[] = [
    { key: "down", color: "var(--status-down)", label: "down" },
    { key: "pending", color: "var(--status-warn)", label: "pending" },
    { key: "maintenance", color: "var(--status-maint)", label: "in maintenance" },
    { key: "up", color: "color-mix(in srgb, var(--status-up) 70%, transparent)", label: "up" },
    { key: "paused", color: "var(--border)", label: "paused" },
];

/** Members as proportional segments; the numbers beside it stay for exactness. */
function HealthBar({ totals }: { totals: GroupNode["totals"] }) {
    if (totals.total === 0) {
        return <span className="flex-1" />;
    }
    const summary = SEGMENTS.filter((s) => totals[s.key] > 0)
        .map((s) => `${totals[s.key]} ${s.label}`)
        .join(", ");
    return (
        <span className="group-health" role="img" aria-label={summary} title={summary}>
            {SEGMENTS.filter((s) => totals[s.key] > 0).map((s) => (
                <span key={s.key} style={{ flexGrow: totals[s.key], background: s.color }} />
            ))}
        </span>
    );
}

/** Group header row: chevron, worst-of dot and word, name and counts. The whole row toggles. */
export const GroupRow = memo(function GroupRow({
    group,
    depth,
    expanded,
    isCursor,
}: {
    group: GroupNode;
    depth: number;
    expanded: boolean;
    isCursor: boolean;
}) {
    const actions = useBoardActions();
    const items = groupMenuItems(group.monitor, group.worst);
    return (
        <RowContextMenu monitorId={group.id} items={items}>
            <div
                className="board-row"
                data-kind="group"
                data-status={group.worst}
                data-depth={depth}
                data-cursor={isCursor || undefined}
                data-row-id={group.id}
                style={{ "--depth": depth } as CSSProperties}
                onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, input, a, label, [role=checkbox]")) {
                        return;
                    }
                    actions.toggleGroup(group.id);
                }}
            >
                <button
                    type="button"
                    data-row-main={group.id}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${group.monitor.name}`}
                    onClick={() => actions.toggleGroup(group.id)}
                    className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded"
                >
                    <ChevronRight
                        aria-hidden
                        className={cn(
                            "size-3.5 transition-transform motion-reduce:transition-none",
                            expanded && "rotate-90"
                        )}
                    />
                </button>
                <StatusDot status={group.worst} muted={isCovered(group.monitor)} />
                <div className="flex min-w-0 items-baseline gap-2 py-1.5">
                    <span className={cn("truncate", depth === 0 ? "font-semibold" : "font-medium")}>
                        {group.monitor.name}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{group.totals.total}</span>
                </div>
                <span
                    className={cn(
                        "board-row-word text-xs",
                        group.worst === "up"
                            ? "text-muted-foreground"
                            : group.worst === "down"
                              ? "text-status-down font-medium"
                              : "text-muted-foreground"
                    )}
                >
                    {group.totals.total === 0 ? "Empty" : group.worst === "up" ? "" : STATUS_LABEL[group.worst]}
                </span>
                <div className="board-strip-cell col-span-2 flex min-w-0 items-center justify-end gap-3">
                    <HealthBar totals={group.totals} />
                    <Counts totals={group.totals} />
                </div>
                <RowMenuButton name={`group ${group.monitor.name}`} monitorId={group.id} items={items} />
            </div>
        </RowContextMenu>
    );
});
