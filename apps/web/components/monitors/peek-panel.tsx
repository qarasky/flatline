"use client";

import { useEffect } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useMedia } from "@/hooks/use-media";

import { MonitorDetail, type DetailMonitor } from "./monitor-detail";

/** At this width the peek sits beside the list; below it, it slides over as a sheet. */
export const WIDE_QUERY = "(min-width: 1280px)";

/**
 * The open monitor beside the list (Plane's peek): the list stays visible
 * and in place. Esc closes it unless a dialog or menu is open, which closes
 * itself first.
 */
export function PeekPanel({
    id,
    onClose,
    onGone,
    onEdit,
}: {
    id: number | null;
    onClose: () => void;
    /** The monitor was deleted while open: the panel says so, the URL drops it. */
    onGone: () => void;
    onEdit?: (monitor: DetailMonitor) => void;
}) {
    const wide = useMedia(WIDE_QUERY);

    useEffect(() => {
        if (id === null || !wide) {
            return;
        }
        function onKey(event: KeyboardEvent) {
            if (event.key !== "Escape" || event.defaultPrevented) {
                return;
            }
            if (document.querySelector('[role="dialog"],[role="menu"]')) {
                return;
            }
            onClose();
        }
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [id, wide, onClose]);

    if (id === null) {
        return null;
    }
    const detail = <MonitorDetail key={id} id={id} compact onClose={onClose} onEdit={onEdit} onDeleted={onGone} />;
    if (wide) {
        return (
            <aside
                aria-label="Monitor details"
                className="bg-background sticky top-12 h-[calc(100svh-3rem)] w-[480px] shrink-0 overflow-y-auto border-l"
            >
                {detail}
            </aside>
        );
    }
    return (
        <Sheet open onOpenChange={(open) => !open && onClose()}>
            <SheetContent side="right" showCloseButton={false} className="w-full overflow-y-auto sm:max-w-xl">
                <SheetTitle className="sr-only">Monitor details</SheetTitle>
                {detail}
            </SheetContent>
        </Sheet>
    );
}
