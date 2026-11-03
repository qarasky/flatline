"use client";

import { ConfirmDialog } from "@qarasky/kore-ui";

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
    const count = monitors.length;

    async function remove() {
        const results = await Promise.allSettled(monitors.map((m) => deleteMonitor(m.id)));
        const { deleted, failed } = splitDeleteResults(monitors, results);
        onDone(deleted, failed);
    }

    return (
        <ConfirmDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={`Delete ${count === 1 ? `“${monitors[0].name}”` : `${count} monitors`}?`}
            description="Their checks and history go with them. This can't be undone."
            confirmLabel="Delete"
            pendingLabel="Deleting…"
            danger
            onConfirm={remove}
        >
            {count > 1 ? (
                <ul className="text-muted text-meta max-h-40 list-disc overflow-y-auto pl-5">
                    {monitors.map((m) => (
                        <li key={m.id}>{m.name}</li>
                    ))}
                </ul>
            ) : null}
        </ConfirmDialog>
    );
}
