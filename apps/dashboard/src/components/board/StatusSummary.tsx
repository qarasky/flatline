import { useRef } from "react";
import { AnimatePresence, m } from "motion/react";
import { STATUS_LABEL, summarySentence } from "@/lib/board-format";
import type { AttentionItem } from "@/lib/attention";
import { STATUS_KEYS, type StatusKey, type Totals } from "@/lib/board-model";
import { HIGHLIGHT_MS, curve } from "@/lib/motion";
import type { Cue } from "./useBoardData";
import { Chip } from "./Popover";
import { StatusDot } from "./StatusDot";

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad", maint: "text-maint", quiet: "text-muted" };
const TONE_DOT: Record<string, StatusKey> = {
    ok: "up",
    warn: "pending",
    bad: "down",
    maint: "maintenance",
    quiet: "paused",
};

/**
 * The fleet state in words, with counts that double as status filters.
 *
 * Counts swap instantly. A burst of status changes (more than the cap) tints
 * the banner once and says how many changed, instead of animating each row.
 */
export function StatusSummary({
    totals,
    attention,
    active,
    onToggleStatus,
    cue,
    calm,
    paused,
    pending,
    onResume,
}: {
    totals: Totals;
    attention: AttentionItem[];
    active: StatusKey[];
    onToggleStatus: (status: StatusKey) => void;
    cue: Cue;
    calm: boolean;
    paused: boolean;
    pending: number;
    onResume: () => void;
}) {
    const summary = summarySentence(totals, attention);
    const cueRef = useRef(0);
    cueRef.current = cue.seq;

    return (
        <section
            aria-label="Fleet status"
            className="relative flex flex-wrap items-center gap-x-6 gap-y-3 overflow-hidden rounded-lg border border-border bg-surface px-5 py-4"
        >
            <AnimatePresence>
                {cue.group && !calm ? (
                    <m.span
                        key={cue.seq}
                        aria-hidden
                        className="pointer-events-none absolute inset-0 bg-primary/10"
                        initial={{ opacity: 1 }}
                        animate={{ opacity: 0 }}
                        transition={{ duration: HIGHLIGHT_MS / 1000, ease: curve.standard }}
                    />
                ) : null}
            </AnimatePresence>

            <div className="flex min-w-0 items-center gap-3" role="status">
                <StatusDot status={TONE_DOT[summary.tone]} size={14} />
                <span className={`text-lg font-semibold tracking-tight ${TONE_TEXT[summary.tone]}`}>
                    {summary.text}
                </span>
                {cue.group && cue.changed > 0 ? (
                    <span className="tnum text-xs text-quiet">{cue.changed} just changed</span>
                ) : null}
            </div>

            {paused ? (
                <div className="flex items-center gap-2 text-xs text-warn">
                    <span>Live updates paused</span>
                    {pending > 0 ? <span className="tnum text-quiet">· changes waiting</span> : null}
                    <button
                        type="button"
                        onClick={onResume}
                        className="rounded border border-border px-2 py-0.5 text-foreground transition-colors hover:bg-surface-hover"
                    >
                        Resume
                    </button>
                </div>
            ) : null}

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {STATUS_KEYS.map((key) => {
                    const count = totals[key];
                    const pressed = active.includes(key);
                    return (
                        <Chip
                            key={key}
                            pressed={pressed}
                            disabled={count === 0 && !pressed}
                            onClick={() => onToggleStatus(key)}
                        >
                            <StatusDot status={key} size={10} />
                            <span className="tnum font-semibold text-foreground">{count}</span>
                            <span className="text-quiet">{STATUS_LABEL[key].toLowerCase()}</span>
                        </Chip>
                    );
                })}
            </div>
        </section>
    );
}
