import { useState } from "react";
import { AnimatePresence, m } from "motion/react";
import type { AttentionItem, AttentionKind } from "@/lib/attention";
import { curve, duration, enterTransition, exitTransition } from "@/lib/motion";
import { StatusDot } from "./StatusDot";

const SHOWN = 6;

function KindMark({ kind }: { kind: AttentionKind }) {
    if (kind === "down") {
        return <StatusDot status="down" />;
    }
    if (kind === "pending") {
        return <StatusDot status="pending" />;
    }
    const glyph = { flapping: "↕", stale: "◌", agent: "!", backup: "▣" }[kind];
    return (
        <span aria-hidden className="inline-flex size-3 items-center justify-center text-[11px] leading-none text-warn">
            {glyph}
        </span>
    );
}

/**
 * Pinned "Needs attention" list. Absent when the fleet is healthy; it fades and
 * grows in rather than sliding over content being read.
 */
export function AttentionSection({
    items,
    onOpen,
    calm,
}: {
    items: AttentionItem[];
    onOpen: (id: number) => void;
    calm: boolean;
}) {
    const [all, setAll] = useState(false);
    const shown = all ? items : items.slice(0, SHOWN);

    return (
        <AnimatePresence initial={false}>
            {items.length > 0 ? (
                <m.section
                    key="attention"
                    aria-label="Needs attention"
                    initial={calm ? false : { height: 0, opacity: 0 }}
                    animate={{
                        height: "auto",
                        opacity: 1,
                        transition: { duration: duration.slow, ease: curve.standard },
                    }}
                    exit={{ height: 0, opacity: 0, transition: exitTransition(duration.slow) }}
                    style={{ overflow: "hidden" }}
                >
                    <div className="rounded-lg border border-bad/30 bg-bad/[0.04]">
                        <h2 className="flex items-baseline gap-2 px-5 pt-4 pb-2 text-sm font-semibold">
                            Needs attention <span className="tnum text-xs font-normal text-quiet">{items.length}</span>
                        </h2>
                        <ul className="pb-2">
                            <AnimatePresence initial={false} mode="popLayout">
                                {shown.map((item) => (
                                    <m.li
                                        key={item.key}
                                        layout={calm ? false : "position"}
                                        initial={calm ? false : { opacity: 0 }}
                                        animate={{ opacity: 1, transition: enterTransition(duration.base) }}
                                        exit={{ opacity: 0, transition: exitTransition(duration.base) }}
                                    >
                                        <button
                                            type="button"
                                            disabled={item.monitorId === null}
                                            onClick={() => item.monitorId !== null && onOpen(item.monitorId)}
                                            className="grid w-full grid-cols-[12px_112px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
                                        >
                                            <KindMark kind={item.kind} />
                                            <span
                                                className={`text-xs font-medium ${item.kind === "down" ? "text-bad" : "text-warn"}`}
                                            >
                                                {item.title}
                                            </span>
                                            <span className="truncate text-sm font-medium">{item.name}</span>
                                            <span className="tnum truncate text-xs text-muted">{item.detail}</span>
                                        </button>
                                    </m.li>
                                ))}
                            </AnimatePresence>
                        </ul>
                        {items.length > SHOWN ? (
                            <button
                                type="button"
                                onClick={() => setAll((v) => !v)}
                                className="w-full border-t border-border px-5 py-2 text-left text-xs text-muted transition-colors hover:text-foreground"
                            >
                                {all ? "Show fewer" : `Show ${items.length - SHOWN} more`}
                            </button>
                        ) : null}
                    </div>
                </m.section>
            ) : null}
        </AnimatePresence>
    );
}
