import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";
import { POPOVER_SECONDS, POP_SCALE } from "@/lib/motion";

/**
 * Anchored popover: fades in with a 0.97 scale from its trigger corner,
 * leaves faster. Closes on outside press and Escape. The marker attribute
 * lets the board's own Escape handling stand down while one is open.
 */
export function Popover({
    open,
    onClose,
    children,
    align = "left",
    className = "",
    label,
}: {
    open: boolean;
    onClose: () => void;
    children: ReactNode;
    align?: "left" | "right";
    className?: string;
    label: string;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointer = (event: PointerEvent) => {
            const target = event.target as Node;
            // Presses on the trigger (the wrapper) are handled by the trigger itself.
            if (ref.current && !ref.current.parentElement?.contains(target)) {
                onClose();
            }
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("pointerdown", onPointer);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", onPointer);
            window.removeEventListener("keydown", onKey);
        };
    }, [open, onClose]);

    return (
        <AnimatePresence>
            {open ? (
                <m.div
                    ref={ref}
                    role="dialog"
                    aria-label={label}
                    data-popover-open
                    initial={{ opacity: 0, scale: POP_SCALE }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: POP_SCALE, transition: { duration: POPOVER_SECONDS * 0.6 } }}
                    transition={{ duration: POPOVER_SECONDS, ease: [0, 0, 0.38, 0.9] }}
                    style={{ transformOrigin: align === "left" ? "top left" : "top right" }}
                    className={`absolute top-full z-30 mt-2 rounded-lg border border-border bg-surface-2 p-3 shadow-xl ${
                        align === "left" ? "left-0" : "right-0"
                    } ${className}`}
                >
                    {children}
                </m.div>
            ) : null}
        </AnimatePresence>
    );
}

/** A toggle chip used by the filter popover and the summary banner. */
export function Chip({
    pressed,
    onClick,
    children,
    disabled,
}: {
    pressed: boolean;
    onClick: () => void;
    children: ReactNode;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors disabled:opacity-40 ${
                pressed
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border text-muted hover:bg-surface-hover hover:text-foreground"
            }`}
        >
            {children}
        </button>
    );
}
