"use client";

import { Pause, Play, Trash2, X } from "lucide-react";

import { Button, IconButton } from "@qarasky/kore-ui";

/** Floats over the list while rows are selected: bulk Pause, Resume, Delete and Clear. */
export function SelectionBar({
    count,
    busy,
    onPause,
    onResume,
    onDelete,
    onClear,
}: {
    count: number;
    busy: boolean;
    onPause: () => void;
    onResume: () => void;
    onDelete: () => void;
    onClear: () => void;
}) {
    if (count === 0) {
        return null;
    }
    return (
        <div
            role="toolbar"
            aria-label="Selected monitors"
            className="bg-raised fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-overlay border border-border-strong px-2 py-1.5 shadow-overlay"
        >
            <span className="text-sub px-2 tabular-nums">{count} selected</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onPause}>
                <Pause />
                Pause
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onResume}>
                <Play />
                Resume
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={onDelete} className="text-danger">
                <Trash2 />
                Delete
            </Button>
            <IconButton label="Clear selection" icon={<X />} disabled={busy} onClick={onClear} />
        </div>
    );
}
