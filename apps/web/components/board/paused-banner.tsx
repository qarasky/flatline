"use client";

import { Button } from "@/components/ui/button";

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
        <div role="status" className="bg-status-warn/10 text-status-warn flex items-center gap-3 px-4 py-1.5 text-xs">
            <span>
                Live updates paused
                {pending > 0 ? <span className="tabular-nums"> · {pending} waiting</span> : null}
            </span>
            <Button variant="outline" size="xs" onClick={() => setPaused(false)}>
                Resume
            </Button>
        </div>
    );
}
