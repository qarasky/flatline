"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cleanMonitorName } from "@/lib/fleet-presentation";
import type { MonitorSummary } from "@/lib/monitor-types";
import { updateMonitor } from "@/lib/monitors-api";

/** Rename a monitor or group; the live invalidate brings the new name to every open board. */
export function RenameDialog({
    monitor,
    onClose,
    onDone,
}: {
    monitor: MonitorSummary;
    onClose: () => void;
    onDone: () => void;
}) {
    const [name, setName] = useState(monitor.name);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save(event: FormEvent) {
        event.preventDefault();
        const next = cleanMonitorName(name);
        if (!next) {
            setError("The name can't be empty.");
            return;
        }
        if (next === monitor.name) {
            onClose();
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await updateMonitor(monitor.id, { name: next });
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Rename failed.");
            setSaving(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={(e) => void save(e)} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Rename {monitor.type === "group" ? "group" : "monitor"}</DialogTitle>
                    </DialogHeader>
                    <Input
                        aria-label="Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={saving}
                        autoFocus
                        maxLength={150}
                    />
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
                            {saving ? "Saving…" : "Rename"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
