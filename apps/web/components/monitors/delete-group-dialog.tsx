"use client";

import { useState } from "react";

import { Checkbox, ConfirmDialog } from "@qarasky/kore-ui";

import { directChildren, subtreeMonitorCount } from "@/lib/groups";
import type { MonitorSummary } from "@/lib/monitor-types";
import { deleteMonitor, updateMonitor } from "@/lib/monitors-api";

/**
 * Delete a group. By default its direct children move up to the group's
 * parent, so nothing is orphaned or lost; ticking "Also delete everything
 * inside" deletes the whole subtree with its history in one request.
 */
export function DeleteGroupDialog({
    group,
    monitors,
    onClose,
    onDone,
}: {
    group: MonitorSummary;
    monitors: MonitorSummary[];
    onClose: () => void;
    onDone: () => void;
}) {
    const rows = subtreeMonitorCount(monitors, group.id);
    const children = directChildren(monitors, group.id);
    const parentName = monitors.find((m) => m.id === group.parent)?.name ?? null;
    const [purge, setPurge] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Throwing keeps the dialog open with the error showing.
    async function submit() {
        setError(null);
        try {
            if (purge) {
                await deleteMonitor(group.id, true);
            } else {
                await Promise.all(children.map((child) => updateMonitor(child.id, { parent: group.parent ?? null })));
                await deleteMonitor(group.id);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Delete failed.");
            throw e;
        }
        onDone();
    }

    const n = children.length;
    return (
        <ConfirmDialog
            open
            onOpenChange={(open) => !open && onClose()}
            title={`Delete group “${group.name}”?`}
            description={`${n} direct ${n === 1 ? "child" : "children"} · ${rows} ${rows === 1 ? "monitor" : "monitors"} inside the whole subtree.`}
            confirmLabel={purge ? `Delete group and ${rows}` : "Delete group"}
            pendingLabel="Deleting…"
            danger
            onConfirm={submit}
        >
            <div className="space-y-3">
                <Checkbox
                    checked={purge}
                    onCheckedChange={(c) => setPurge(c === true)}
                    label="Also delete everything inside"
                    description={`Unticked, the ${n} direct ${n === 1 ? "child moves" : "children move"} up to ${parentName ?? "the top level"} and nothing is lost.`}
                />
                {purge && rows > 0 ? (
                    <p role="alert" className="bg-danger/10 text-danger text-meta rounded-ui px-2.5 py-2">
                        {rows} {rows === 1 ? "monitor" : "monitors"} will be deleted with their history. This can't be
                        undone.
                    </p>
                ) : null}
                {error ? (
                    <p role="alert" className="text-danger text-meta">
                        {error}
                    </p>
                ) : null}
            </div>
        </ConfirmDialog>
    );
}
