"use client";

import { Dialog, DialogContent } from "@qarasky/kore-ui";

import { useMedia } from "@/hooks/use-media";

import { MonitorDetail } from "./monitor-detail";

/** At this width the peek sits beside the list; below it, it opens over the list as a side dialog. */
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
    // kore-ui has no sheet: a Dialog pinned to the right edge, full height.
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                title={<span className="sr-only">Monitor details</span>}
                showClose={false}
                className="top-0 right-0 left-auto h-dvh max-h-dvh w-full translate-x-0 translate-y-0 rounded-none border-y-0 border-r-0 sm:max-w-xl"
            >
                <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
            </DialogContent>
        </Dialog>
    );
}
