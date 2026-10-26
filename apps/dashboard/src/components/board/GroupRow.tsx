import { memo, type CSSProperties } from "react";
import { m } from "motion/react";
import type { MonitorSummary } from "@/lib/api";
import { STATUS_LABEL } from "@/lib/board-format";
import type { GroupNode } from "@/lib/board-model";
import { duration, enterTransition } from "@/lib/motion";
import { useBoardActions } from "./board-context";
import { isCovered } from "@/lib/mute";
import { StatusDot } from "./StatusDot";

/** Up / down counts that still tell the truth when the group is collapsed. */
function Counts({ totals }: { totals: GroupNode["totals"] }) {
    const parts: { text: string; tone: string }[] = [];
    if (totals.down > 0) {
        parts.push({ text: `${totals.down} down`, tone: "text-bad font-medium" });
    }
    if (totals.pending > 0) {
        parts.push({ text: `${totals.pending} pending`, tone: "text-warn font-medium" });
    }
    if (totals.maintenance > 0) {
        parts.push({ text: `${totals.maintenance} maintenance`, tone: "text-maint" });
    }
    parts.push({ text: `${totals.up} up`, tone: "text-quiet" });
    if (totals.paused > 0) {
        parts.push({ text: `${totals.paused} paused`, tone: "text-quiet" });
    }
    return (
        <span className="tnum flex flex-wrap justify-end gap-x-2 text-xs">
            {parts.map((part) => (
                <span key={part.text} className={part.tone}>
                    {part.text}
                </span>
            ))}
        </span>
    );
}

/**
 * Group header row: chevron, worst-of dot and word, name and counts.
 * The whole row toggles; the chevron rotates.
 */
export const GroupRow = memo(function GroupRow({
    group,
    depth,
    expanded,
    isCursor,
    menuOpen,
    calm,
}: {
    group: GroupNode;
    depth: number;
    expanded: boolean;
    isCursor?: boolean;
    menuOpen: boolean;
    calm: boolean;
}) {
    const actions = useBoardActions();
    const monitor: MonitorSummary = group.monitor;

    return (
        <div
            className="board-row"
            data-kind="group"
            data-status={group.worst}
            data-menu={menuOpen || undefined}
            data-row-id={group.id}
            data-cursor={isCursor || undefined}
            style={{ "--depth": depth } as CSSProperties}
            onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, input, a, label")) {
                    return;
                }
                actions.toggleGroup(group.id);
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                actions.openMenu(monitor, event.clientX, event.clientY);
            }}
        >
            <button
                type="button"
                data-row-main={group.id}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${group.monitor.name}`}
                onClick={() => actions.toggleGroup(group.id)}
                className="flex size-5 items-center justify-center rounded text-quiet transition-colors hover:text-foreground"
            >
                <m.svg
                    viewBox="0 0 12 12"
                    width="10"
                    height="10"
                    aria-hidden
                    initial={false}
                    animate={{ rotate: expanded ? 90 : 0 }}
                    transition={calm ? { duration: 0 } : enterTransition(duration.base)}
                >
                    <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </m.svg>
            </button>
            <StatusDot status={group.worst} muted={isCovered(group.monitor)} />

            <div className="flex min-w-0 items-baseline gap-2 py-2">
                <span className="truncate text-sm font-semibold">{group.monitor.name}</span>
                <span className="tnum shrink-0 text-xs text-quiet">{group.totals.total}</span>
            </div>

            <span
                className={`board-row-word text-xs ${group.worst === "up" ? "text-quiet" : group.worst === "down" ? "font-medium text-bad" : "text-muted"}`}
            >
                {group.totals.total === 0 ? "Empty" : STATUS_LABEL[group.worst]}
            </span>
            <div className="board-strip-cell col-span-2 min-w-0 text-right">
                <Counts totals={group.totals} />
            </div>

            <button
                type="button"
                aria-label={`Actions for group ${group.monitor.name}`}
                title="Group actions"
                aria-haspopup="menu"
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    actions.openMenu(monitor, rect.left, rect.bottom + 4);
                }}
                className="board-reveal rounded px-1.5 py-0.5 text-quiet transition-colors hover:bg-card hover:text-foreground"
            >
                ⋯
            </button>
        </div>
    );
});
