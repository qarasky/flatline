"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { usageTone } from "@/components/fleet/metric-bar";

const TONE_TEXT: Record<ReturnType<typeof usageTone>, string> = {
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
    muted: "text-quiet",
};

/**
 * One square per core, each carrying its own load inside.
 *
 * The number is the signal; the fill rising from the bottom and the colour
 * are reinforcement for the eye across a wall. A number-free grid forced the
 * eye to a separate total, and a total hides which core is pinned — so each
 * square shows its own percentage and the card shows no aggregate at all.
 * The container's tooltip still spells out every core for a screen reader.
 */
export function CoreSquares({ values, label }: { values?: number[]; label: string }) {
    if (!values || values.length === 0) {
        return null;
    }

    return (
        <div
            className="core-squares flex flex-wrap gap-1"
            role="img"
            aria-label={`${label} loads: ${values.map((v, i) => `${i}: ${Number.isFinite(v) ? `${Math.round(v)}%` : "unknown"}`).join(", ")}`}
        >
            {values.map((value, i) => {
                const known = Number.isFinite(value);
                const safe = known ? Math.max(0, Math.min(100, value)) : 0;
                return (
                    <span
                        key={i}
                        title={`${label} ${i}: ${known ? `${safe.toFixed(1)}%` : "unknown"}`}
                        className={cn(
                            "core-square inline-flex items-center justify-center overflow-hidden rounded-[4px] border border-white/10 bg-white/5",
                            TONE_TEXT[usageTone(value)]
                        )}
                        style={{ "--load": known ? safe : 0 } as CSSProperties}
                    >
                        <span className="core-square-fill" aria-hidden="true" />
                        <span className="core-square-value">{known ? Math.round(safe) : "—"}</span>
                    </span>
                );
            })}
        </div>
    );
}
