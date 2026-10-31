"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type { MonitorSummary } from "@/lib/monitor-types";
import { deleteMonitor } from "@/lib/monitors-api";

/** Delete monitors (from a row menu or the selection), naming each, and reporting any that failed. */
export function DeleteMonitorsDialog({
    monitors,
    onClose,
    onDone,
}: {
    monitors: MonitorSummary[];
    onClose: () => void;
    /** Called with the ids that were deleted. */
    onDone: (deleted: number[]) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const count = monitors.length;

    async function remove() {
        setBusy(true);
        setError(null);
        const results = await Promise.allSettled(monitors.map((m) => deleteMonitor(m.id)));
        const failed = monitors.filter((_, i) => results[i].status === "rejected").map((m) => m.name);
        const deleted = monitors.filter((_, i) => results[i].status === "fulfilled").map((m) => m.id);
        if (failed.length > 0) {
            setError(`Could not delete ${failed.join(", ")}.`);
            setBusy(false);
            if (deleted.length > 0) {
                onDone(deleted);
            }
            return;
        }
        onDone(deleted);
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Delete {count === 1 ? `“${monitors[0].name}”` : `${count} monitors`}?</DialogTitle>
                    <DialogDescription>Their checks and history go with them. This cannot be undone.</DialogDescription>
                </DialogHeader>
                {count > 1 ? (
                    <ul className="text-muted-foreground max-h-40 list-disc overflow-y-auto pl-5 text-xs">
                        {monitors.map((m) => (
                            <li key={m.id}>{m.name}</li>
                        ))}
                    </ul>
                ) : null}
                {error ? (
                    <p role="alert" className="text-status-down text-xs">
                        {error}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
                        {busy ? "Deleting…" : "Delete"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
