"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { groupOptions } from "@/lib/groups";
import type { MonitorSummary } from "@/lib/monitor-types";
import { updateMonitor } from "@/lib/monitors-api";

/** Move a monitor or group to another group (never into its own subtree). */
export function MoveDialog({
    monitor,
    monitors,
    onClose,
    onDone,
}: {
    monitor: MonitorSummary;
    monitors: MonitorSummary[];
    onClose: () => void;
    onDone: () => void;
}) {
    const options = groupOptions(monitors, monitor.type === "group" ? monitor.id : null);
    const [parent, setParent] = useState(monitor.parent != null ? String(monitor.parent) : "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save(event: FormEvent) {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
            await updateMonitor(monitor.id, { parent: parent ? Number(parent) : null });
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Move failed.");
            setSaving(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={(e) => void save(e)} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Move to group</DialogTitle>
                        <DialogDescription>Where should “{monitor.name}” live in the tree?</DialogDescription>
                    </DialogHeader>
                    <NativeSelect
                        aria-label="Group"
                        className="w-full"
                        value={parent}
                        disabled={saving}
                        onChange={(e) => setParent(e.target.value)}
                    >
                        <NativeSelectOption value="">— none (top level)</NativeSelectOption>
                        {options.map((o) => (
                            <NativeSelectOption key={o.value} value={o.value}>
                                {o.label}
                            </NativeSelectOption>
                        ))}
                    </NativeSelect>
                    {error ? (
                        <p role="alert" className="text-status-down text-xs">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? "Moving…" : "Move"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
