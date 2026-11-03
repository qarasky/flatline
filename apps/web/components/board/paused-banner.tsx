"use client";

import { Button } from "@qarasky/kore-ui";

import { useBoardData } from "./board-data";

/**
 * Says that live updates are paused (Pause on Monitors holds the whole
 * admin area's roster) and offers Resume, on every page that shows status.
 */
export function PausedBanner() {
    const { paused, pending, setPaused } = useBoardData();
    if (!paused) {
        return null;
    }
    return (
        <div
            role="status"
            className="bg-status-warn/10 text-status-warn text-meta flex shrink-0 items-center gap-3 px-4 py-1.5"
        >
            <span>
                Live updates paused
                {pending > 0 ? <span className="tabular-nums"> · {pending} waiting</span> : null}
            </span>
            <Button size="sm" className="min-h-7 px-2.5" onClick={() => setPaused(false)}>
                Resume
            </Button>
        </div>
    );
}
