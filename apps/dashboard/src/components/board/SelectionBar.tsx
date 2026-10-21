import { AnimatePresence, m } from "motion/react";
import { Button } from "@/components/ui/button";
import { duration, enterTransition, exitTransition } from "@/lib/motion";

/** Bulk actions for the selection. Floats at the bottom so it never shifts the list. */
export function SelectionBar({
    count,
    busy,
    onAction,
    onClear,
}: {
    count: number;
    busy: boolean;
    onAction: (action: "pause" | "resume" | "delete") => void;
    onClear: () => void;
}) {
    return (
        <AnimatePresence>
            {count > 0 ? (
                <m.div
                    role="toolbar"
                    aria-label="Bulk actions"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: enterTransition(duration.base) }}
                    exit={{ opacity: 0, transition: exitTransition(duration.base) }}
                    className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-2.5 shadow-2xl"
                >
                    <span className="mr-2 text-xs text-muted">
                        <span className="tnum font-semibold text-foreground">{count}</span> selected
                    </span>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction("pause")}>
                        Pause
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction("resume")}>
                        Resume
                    </Button>
                    <Button variant="destructive" size="sm" disabled={busy} onClick={() => onAction("delete")}>
                        Delete
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onClear}>
                        Clear
                    </Button>
                </m.div>
            ) : null}
        </AnimatePresence>
    );
}
