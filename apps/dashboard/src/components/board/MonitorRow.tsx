import { memo, type CSSProperties } from "react";
import { m } from "motion/react";
import type { MonitorSummary } from "@/lib/api";
import { STATUS_LABEL, checkedAgo, formatPing, formatUptime, monitorTarget } from "@/lib/board-format";
import { statusKeyOf } from "@/lib/board-model";
import type { Strip } from "@/lib/heartbeat-strip";
import { HIGHLIGHT_MS, curve } from "@/lib/motion";
import { useBoardActions } from "./board-context";
import { HeartbeatStrip } from "./HeartbeatStrip";
import { StatusDot, statusTone } from "./StatusDot";

const FLASH: Record<string, string> = {
    down: "color-mix(in srgb, var(--color-bad) 22%, transparent)",
    up: "color-mix(in srgb, var(--color-ok) 16%, transparent)",
    pending: "color-mix(in srgb, var(--color-warn) 18%, transparent)",
    maintenance: "color-mix(in srgb, var(--color-maint) 18%, transparent)",
    paused: "transparent",
};

export interface MonitorRowProps {
    monitor: MonitorSummary;
    depth: number;
    strip: Strip | undefined;
    selected: boolean;
    isOpen: boolean;
    menuOpen: boolean;
    selecting: boolean;
    /** Non-zero while this row's status change is highlighted; changes per batch. */
    flashSeq: number;
    calm: boolean;
    now: number;
}

/**
 * One monitor row: `[check] [dot] name + quiet target | status word | strip | uptime | menu`.
 *
 * Ping, last check and type replace the target text on hover/focus (CSS only).
 * The checkbox and menu are always in the DOM and tabbable but only visible on
 * hover, focus, selection or an open menu.
 */
export const MonitorRow = memo(function MonitorRow({
    monitor,
    depth,
    strip,
    selected,
    isOpen,
    menuOpen,
    selecting,
    flashSeq,
    calm,
    now,
}: MonitorRowProps) {
    const actions = useBoardActions();
    const status = statusKeyOf(monitor);
    const label = STATUS_LABEL[status];

    return (
        <div
            className="board-row"
            data-kind="monitor"
            data-status={status}
            data-selected={selected || undefined}
            data-open={isOpen || undefined}
            data-menu={menuOpen || undefined}
            data-row-id={monitor.id}
            style={{ "--depth": depth } as CSSProperties}
            onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, input, a, label")) {
                    return;
                }
                actions.openMonitor(monitor.id);
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                actions.openMenu(monitor, event.clientX, event.clientY);
            }}
        >
            {flashSeq > 0 && !calm ? (
                <m.span
                    key={flashSeq}
                    aria-hidden
                    className="pointer-events-none absolute inset-0"
                    style={{ background: FLASH[status] }}
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: HIGHLIGHT_MS / 1000, ease: curve.standard }}
                />
            ) : null}

            <input
                type="checkbox"
                checked={selected}
                onChange={() => actions.toggleSelect(monitor.id)}
                aria-label={`Select ${monitor.name}`}
                className="board-reveal size-3.5 cursor-pointer accent-[var(--primary)]"
                data-selecting={selecting || undefined}
            />
            <StatusDot status={status} />

            <div className="flex min-w-0 flex-col justify-center gap-0.5 py-2 board-compact-inline">
                <button
                    type="button"
                    data-row-main={monitor.id}
                    onClick={() => actions.openMonitor(monitor.id)}
                    aria-current={isOpen || undefined}
                    className="min-w-0 truncate text-left text-sm font-medium text-foreground focus-visible:outline-offset-4"
                >
                    {monitor.name}
                </button>
                <span className="board-meta text-xs">
                    <span className="board-meta-rest text-quiet">{monitorTarget(monitor)}</span>
                    <span className="board-meta-detail tnum text-muted">
                        {monitor.type} · {formatPing(monitor.ping)} · checked {checkedAgo(monitor.lastCheck, now)}
                    </span>
                </span>
            </div>

            <span
                className={`board-row-word text-xs ${status === "up" ? "text-quiet" : `${statusTone(status)} font-medium`}`}
            >
                {label}
            </span>
            <HeartbeatStrip strip={strip} name={monitor.name} now={now} calm={calm} />
            <span className="tnum text-right text-xs text-muted">{formatUptime(monitor.uptime24h)}</span>

            <button
                type="button"
                aria-label={`Actions for ${monitor.name}`}
                title="Actions"
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
