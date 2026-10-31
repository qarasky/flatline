"use client";

import { ChevronRight } from "lucide-react";
import { memo, type CSSProperties } from "react";

import { STATUS_LABEL } from "@/lib/board-format";
import type { GroupNode } from "@/lib/board-model";
import { isCovered } from "@/lib/mute";
import { cn } from "@/lib/utils";

import { useBoardActions } from "./board-context";
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
        <span className="flex flex-wrap justify-end gap-x-2 text-xs tabular-nums">
            {parts.map((part) => (
                <span key={part.text} className={part.tone}>
                    {part.text}
                </span>
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
    return (
        <div
            className="board-row"
            data-kind="group"
            data-status={group.worst}
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
                <span className="truncate font-semibold">{group.monitor.name}</span>
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
                {group.totals.total === 0 ? "Empty" : STATUS_LABEL[group.worst]}
            </span>
            <div className="board-strip-cell col-span-2 min-w-0 text-right">
                <Counts totals={group.totals} />
            </div>
            <span data-slot="menu" />
        </div>
    );
});
