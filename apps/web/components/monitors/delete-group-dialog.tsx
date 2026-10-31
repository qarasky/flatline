"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (purge) {
                await deleteMonitor(group.id, true);
            } else {
                await Promise.all(children.map((child) => updateMonitor(child.id, { parent: group.parent ?? null })));
                await deleteMonitor(group.id);
            }
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Delete failed.");
            setBusy(false);
        }
    }

    const n = children.length;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={(e) => void submit(e)} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Delete group “{group.name}”</DialogTitle>
                        <DialogDescription>
                            {n} direct {n === 1 ? "child" : "children"} · {rows} {rows === 1 ? "monitor" : "monitors"}{" "}
                            inside the whole subtree.
                        </DialogDescription>
                    </DialogHeader>
                    <label className="flex items-start gap-2">
                        <Checkbox
                            checked={purge}
                            disabled={busy}
                            onCheckedChange={(c) => setPurge(c === true)}
                            className="mt-0.5"
                        />
                        <span>
                            Also delete everything inside
                            <span className="text-muted-foreground block text-xs">
                                Unticked, the {n} direct {n === 1 ? "child moves" : "children move"} up to{" "}
                                {parentName ?? "the top level"} and nothing is lost.
                            </span>
                        </span>
                    </label>
                    {purge && rows > 0 ? (
                        <p role="alert" className="bg-status-down/10 text-status-down rounded-md px-2.5 py-2 text-xs">
                            {rows} {rows === 1 ? "monitor" : "monitors"} will be deleted with their history. This cannot
                            be undone.
                        </p>
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
                        <Button type="submit" variant="destructive" disabled={busy}>
                            {busy ? "Deleting…" : purge ? `Delete group and ${rows}` : "Delete group"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
