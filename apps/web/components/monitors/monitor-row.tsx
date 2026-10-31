"use client";

import { memo, type CSSProperties } from "react";

import { STATUS_LABEL, checkedAgo, formatPing, formatUptime, monitorTarget } from "@/lib/board-format";
import { statusKeyOf } from "@/lib/board-model";
import type { Strip } from "@/lib/heartbeat-strip";
import type { MonitorSummary } from "@/lib/monitor-types";
import { isCovered } from "@/lib/mute";
import { monitorMenuItems } from "@/lib/row-menu";
import { cn } from "@/lib/utils";

import { useBoardActions } from "./board-context";
import { Checkbox } from "@/components/ui/checkbox";

import { HeartbeatStrip } from "./heartbeat-strip";
import { RowContextMenu, RowMenuButton } from "./row-menu";
import { StatusDot, statusTone } from "./status-dot";

const FLASH: Record<string, string> = {
    down: "color-mix(in srgb, var(--status-down) 22%, transparent)",
    up: "color-mix(in srgb, var(--status-up) 16%, transparent)",
    pending: "color-mix(in srgb, var(--status-warn) 18%, transparent)",
    maintenance: "color-mix(in srgb, var(--status-maint) 18%, transparent)",
    paused: "transparent",
};

export interface MonitorRowProps {
    monitor: MonitorSummary;
    depth: number;
    strip: Strip | undefined;
    selected: boolean;
    isOpen: boolean;
    isCursor: boolean;
    /** Non-zero while this row's status change is highlighted; changes per batch. */
    flashSeq: number;
    calm: boolean;
    now: number;
}

/**
 * One monitor row: `[check] [dot] name + quiet target | status word | strip | uptime | menu`.
 * Ping, last check and type replace the target text on hover or focus (CSS only).
 */
export const MonitorRow = memo(function MonitorRow({
    monitor,
    depth,
    strip,
    selected,
    isOpen,
    isCursor,
    flashSeq,
    calm,
    now,
}: MonitorRowProps) {
    const actions = useBoardActions();
    const status = statusKeyOf(monitor);
    // An acknowledged outage reads as down, in the dim red, and says so.
    const muted = status === "down" && isCovered(monitor);
    const label = muted ? `${STATUS_LABEL[status]} · muted` : STATUS_LABEL[status];
    const items = monitorMenuItems(monitor);

    return (
        <RowContextMenu monitorId={monitor.id} items={items}>
            <div
                className="board-row"
                data-kind="monitor"
                data-status={status}
                data-selected={selected || undefined}
                data-open={isOpen || undefined}
                data-cursor={isCursor || undefined}
                data-row-id={monitor.id}
                style={{ "--depth": depth } as CSSProperties}
                onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, input, a, label, [role=checkbox]")) {
                        return;
                    }
                    actions.openMonitor(monitor.id);
                }}
            >
                {flashSeq > 0 && !calm ? (
                    <span
                        key={flashSeq}
                        aria-hidden
                        className="board-flash pointer-events-none absolute inset-0"
                        style={{ "--flash": FLASH[status] } as CSSProperties}
                    />
                ) : null}
                <Checkbox
                    checked={selected}
                    onCheckedChange={() => actions.toggleSelect(monitor.id)}
                    aria-label={`Select ${monitor.name}`}
                    className="board-reveal"
                />
                <StatusDot status={status} muted={muted} />
                <div className="board-compact-inline flex min-w-0 flex-col justify-center gap-0.5 py-1.5">
                    <button
                        type="button"
                        data-row-main={monitor.id}
                        onClick={() => actions.openMonitor(monitor.id)}
                        aria-current={isOpen || undefined}
                        className="text-foreground min-w-0 truncate text-left font-medium focus-visible:outline-offset-4"
                    >
                        {monitor.name}
                    </button>
                    <span className="board-meta text-xs">
                        <span className="board-meta-rest text-muted-foreground/80">{monitorTarget(monitor)}</span>
                        <span className="board-meta-detail text-muted-foreground tabular-nums">
                            {monitor.type} · {formatPing(monitor.ping)} · checked {checkedAgo(monitor.lastCheck, now)}
                        </span>
                    </span>
                </div>
                <span
                    className={cn(
                        "board-row-word text-xs",
                        status === "up"
                            ? "text-muted-foreground"
                            : muted
                              ? "text-status-muted font-medium"
                              : `${statusTone(status)} font-medium`
                    )}
                >
                    {label}
                </span>
                <HeartbeatStrip strip={strip} name={monitor.name} now={now} calm={calm} />
                <span className="text-muted-foreground text-right text-xs tabular-nums">
                    {formatUptime(monitor.uptime24h)}
                </span>
                <RowMenuButton name={monitor.name} monitorId={monitor.id} items={items} />
            </div>
        </RowContextMenu>
    );
});
