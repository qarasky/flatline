import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";
import { curve, duration, exitTransition, spring } from "@/lib/motion";

/** Viewport width from which the detail sits beside the list instead of over it. */
export const WIDE_QUERY = "(min-width: 1280px)";

/**
 * Detail container. Beside the list at >= 1280 px (slides in, list position
 * kept); a full-height sheet below that. Dismiss is faster than enter; Escape
 * is handled by the board.
 */
export function DetailPane({
    open,
    wide,
    onClose,
    calm,
    children,
}: {
    open: boolean;
    wide: boolean;
    onClose: () => void;
    calm: boolean;
    children: ReactNode;
}) {
    const sheetRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open && !wide) {
            sheetRef.current?.focus();
        }
    }, [open, wide]);

    if (wide) {
        return (
            <AnimatePresence initial={false}>
                {open ? (
                    <m.aside
                        key="pane"
                        aria-label="Monitor detail"
                        initial={calm ? false : { opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 12, transition: exitTransition(duration.slow) }}
                        transition={{ ...spring, opacity: { duration: duration.base, ease: curve.entrance } }}
                        className="sticky top-0 h-screen w-[560px] shrink-0 overflow-y-auto border-l border-border bg-background"
                    >
                        {children}
                    </m.aside>
                ) : null}
            </AnimatePresence>
        );
    }

    return (
        <AnimatePresence initial={false}>
            {open ? (
                <m.div key="sheet" className="fixed inset-0 z-40">
                    <m.div
                        aria-hidden
                        className="absolute inset-0 bg-black/55"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, transition: exitTransition(duration.slow) }}
                        onClick={onClose}
                    />
                    <m.div
                        ref={sheetRef}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Monitor detail"
                        tabIndex={-1}
                        initial={calm ? false : { opacity: 0, y: 32 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 16, transition: exitTransition(duration.slow) }}
                        transition={{ ...spring, opacity: { duration: duration.base, ease: curve.entrance } }}
                        className="absolute inset-x-0 top-10 bottom-0 overflow-y-auto rounded-t-xl border border-b-0 border-border bg-background shadow-2xl focus:outline-none"
                    >
                        {children}
                    </m.div>
                </m.div>
            ) : null}
        </AnimatePresence>
    );
}
