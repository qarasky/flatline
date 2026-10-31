"use client";

import { memo, useState } from "react";
import { createPortal } from "react-dom";

import { bucketRange, bucketSummary } from "@/lib/board-format";
import { bucketInfo, type Strip, type StripBucket } from "@/lib/heartbeat-strip";

function cellKey(cell: StripBucket): string {
    if (!cell) {
        return "none";
    }
    switch (cell[0]) {
        case 0:
            return "down";
        case 2:
            return "pending";
        case 3:
            return "maintenance";
        default:
            return "up";
    }
}

function describe(strip: Strip, name: string): string {
    const failed = strip.cells.reduce((sum, cell) => sum + (cell ? cell[2] : 0), 0);
    const worst = strip.cells.reduce<string>((acc, cell) => {
        const key = cellKey(cell);
        return key === "down" || (key === "pending" && acc !== "down") ? key : acc;
    }, "up");
    if (strip.cells.every((c) => !c)) {
        return `${name}: no checks in the last 24 hours`;
    }
    return `${name}, last 24 hours: ${failed} failed check${failed === 1 ? "" : "s"}, worst status ${worst}`;
}

/** The hovered bucket's time range, check count and failures, above the cell. */
function StripTooltip({ strip, index, x, y, now }: { strip: Strip; index: number; x: number; y: number; now: number }) {
    const info = bucketInfo(strip, index);
    if (!info) {
        return null;
    }
    return createPortal(
        <div
            role="tooltip"
            style={{ position: "fixed", left: x, top: y - 8, translate: "-50% -100%" }}
            className="bg-raised pointer-events-none z-[60] rounded-md border px-2.5 py-1.5 text-xs shadow-lg"
        >
            <div className="text-muted-foreground tabular-nums">{bucketRange(info, now)}</div>
            <div className="mt-0.5 font-medium">{bucketSummary(info)}</div>
        </div>,
        document.body
    );
}

/**
 * The 24 h heartbeat strip: 48 half-hour buckets, each coloured by its worst
 * beat; cell height varies by status too. An empty slot when the backend has
 * no strip for this monitor, so the row layout does not move.
 */
export const HeartbeatStrip = memo(function HeartbeatStrip({
    strip,
    name,
    now,
    calm,
}: {
    strip: Strip | undefined;
    name: string;
    now: number;
    calm: boolean;
}) {
    const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
    if (!strip) {
        return <div className="board-strip board-strip-cell" aria-hidden />;
    }
    const last = strip.cells.length - 1;
    return (
        <div
            className="board-strip board-strip-cell"
            role="img"
            aria-label={describe(strip, name)}
            onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const index = Math.min(
                    last,
                    Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * strip.cells.length))
                );
                const cell = rect.width / strip.cells.length;
                setHover({ index, x: rect.left + (index + 0.5) * cell, y: rect.top });
            }}
            onPointerLeave={() => setHover(null)}
        >
            {strip.cells.slice(0, last).map((cell, index) => (
                <span key={index} className="strip-cell" data-s={cellKey(cell)} />
            ))}
            {/* The newest cell fades in once when a live beat changes it; never on a resnapshot (fresh stays 0). */}
            <span
                key={strip.fresh}
                className="strip-cell"
                data-s={cellKey(strip.cells[last])}
                data-fresh={(strip.fresh > 0 && !calm) || undefined}
            />
            {hover ? <StripTooltip strip={strip} index={hover.index} x={hover.x} y={hover.y} now={now} /> : null}
        </div>
    );
});
