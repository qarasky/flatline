"use client";

import { useEffect, useState } from "react";

import { useBoardData } from "@/components/board/board-data";

/**
 * A clock that ticks every `intervalMs` while the tab is visible, starting
 * from the provider's server-seeded time so it hydrates cleanly. Unlike the
 * board's clock it never stops for Pause: freshness must keep counting.
 */
export function useClock(intervalMs = 1000): number {
    const { now: seeded } = useBoardData();
    const [now, setNow] = useState(seeded);
    useEffect(() => {
        const tick = () => {
            if (!document.hidden) {
                setNow(Date.now());
            }
        };
        tick();
        const timer = window.setInterval(tick, intervalMs);
        document.addEventListener("visibilitychange", tick);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", tick);
        };
    }, [intervalMs]);
    return now;
}
