"use client";

import { Pause, Play } from "lucide-react";

import { useBoardData } from "@/components/board/board-data";
import { Button } from "@/components/ui/button";

/** Pause live updates (WCAG 2.2.2): changes wait until Resume. */
export function PauseButton() {
    const { paused, setPaused } = useBoardData();
    return (
        <Button variant="ghost" size="sm" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? <Play /> : <Pause />}
            {paused ? "Resume" : "Pause"}
        </Button>
    );
}
