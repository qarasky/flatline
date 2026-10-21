import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";
import { bucketRange, bucketSummary } from "@/lib/board-format";
import { bucketInfo, type Strip, type StripBucket } from "@/lib/heartbeat-strip";
import { POPOVER_SECONDS, POP_SCALE, duration, enterTransition, tooltipShouldAnimate } from "@/lib/motion";

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
    const quiet = strip.cells.every((c) => !c);
    if (quiet) {
        return `${name}: no checks in the last 24 hours`;
    }
    return `${name}, last 24 hours: ${failed} failed check${failed === 1 ? "" : "s"}, worst status ${worst}`;
}

let openTooltips = 0;

/** Shared hover tooltip for one strip: bucket time range, count and failures. */
function StripTooltip({ strip, index, x, y, now }: { strip: Strip; index: number; x: number; y: number; now: number }) {
    const [animate] = useState(() => tooltipShouldAnimate(openTooltips));
    useEffect(() => {
        openTooltips++;
        return () => {
            openTooltips--;
        };
    }, []);
    const info = bucketInfo(strip, index);
    if (!info) {
        return null;
    }
    return createPortal(
        <m.div
            role="tooltip"
            initial={animate ? { opacity: 0, scale: POP_SCALE } : false}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: POPOVER_SECONDS * 0.6 } }}
            transition={{ duration: POPOVER_SECONDS }}
            style={{
                position: "fixed",
                left: x,
                top: y - 8,
                translate: "-50% -100%",
                transformOrigin: "bottom center",
            }}
            className="pointer-events-none z-[60] rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg"
        >
            <div className="tnum text-muted">{bucketRange(info, now)}</div>
            <div className="mt-0.5 font-medium">{bucketSummary(info)}</div>
        </m.div>,
        document.body
    );
}

/**
 * The 24 h heartbeat strip: 48 half-hour buckets, each coloured by its worst
 * beat. Cell height also varies by status. Renders an empty slot when the
 * backend has no strip for this monitor, so the row layout does not move.
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
            <m.span
                key={strip.fresh}
                className="strip-cell"
                data-s={cellKey(strip.cells[last])}
                initial={strip.fresh > 0 && !calm ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={enterTransition(duration.base)}
            />
            <AnimatePresence>
                {hover ? (
                    <StripTooltip key="tip" strip={strip} index={hover.index} x={hover.x} y={hover.y} now={now} />
                ) : null}
            </AnimatePresence>
        </div>
    );
});
