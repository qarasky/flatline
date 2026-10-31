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
import { splitDeleteResults } from "@/lib/bulk-report";
import { deleteMonitor } from "@/lib/monitors-api";

/** Delete monitors (from a row menu or the selection), naming each; failures go back to the board by name. */
export function DeleteMonitorsDialog({
    monitors,
    onClose,
    onDone,
}: {
    monitors: MonitorSummary[];
    onClose: () => void;
    /** Called with the ids that are gone and the names that could not be deleted. */
    onDone: (deleted: number[], failed: string[]) => void;
}) {
    const [busy, setBusy] = useState(false);
    const count = monitors.length;

    async function remove() {
        setBusy(true);
        const results = await Promise.allSettled(monitors.map((m) => deleteMonitor(m.id)));
        const { deleted, failed } = splitDeleteResults(monitors, results);
        onDone(deleted, failed);
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
