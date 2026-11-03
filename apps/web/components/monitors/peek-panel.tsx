"use client";

import { Sheet, SheetBody, SheetContent } from "@qarasky/kore-ui";

import { useMedia } from "@/hooks/use-media";

import { MonitorDetail } from "./monitor-detail";

/** At this width the peek sits beside the list; below it, it opens over the list as a sheet. */
export const WIDE_QUERY = "(min-width: 1280px)";

/**
 * The open monitor beside the list (Plane's peek): the list stays visible
 * and in place. Esc (handled by the board's keyboard) closes it.
 */
export function PeekPanel({
    id,
    onClose,
    onGone,
    startEditing = false,
}: {
    id: number | null;
    onClose: () => void;
    /** The monitor was deleted while open: the panel says so, the URL drops it. */
    onGone: () => void;
    /** Open with the edit form showing ("Edit…" from a row menu). */
    startEditing?: boolean;
}) {
    const wide = useMedia(WIDE_QUERY);

    if (id === null) {
        return null;
    }
    const detail = (
        <MonitorDetail key={id} id={id} compact onClose={onClose} onDeleted={onGone} startEditing={startEditing} />
    );
    if (wide) {
        return (
            <aside
                aria-label="Monitor details"
                className="bg-surface min-h-0 w-[480px] shrink-0 overflow-y-auto border-l"
            >
                {detail}
            </aside>
        );
    }
    return (
        <Sheet open onOpenChange={(open) => !open && onClose()}>
            <SheetContent title="Monitor details" hideTitle size="lg" showClose={false}>
                <SheetBody className="p-0">{detail}</SheetBody>
            </SheetContent>
        </Sheet>
    );
}
