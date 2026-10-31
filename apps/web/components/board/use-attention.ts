"use client";

import { useMemo } from "react";

import { deriveAttention, type AttentionItem } from "@/lib/attention";

import { useBoardData } from "./board-data";

/** What needs attention now, worst first, muted items last (derived from the shared board data). */
export function useAttention(): AttentionItem[] {
    const { monitors, strips, now, changedAt, agentWarnings, backups } = useBoardData();
    return useMemo(
        () => deriveAttention({ monitors, strips, nowMs: now, changedAt, agentWarnings, backups }),
        [monitors, strips, now, changedAt, agentWarnings, backups]
    );
}
