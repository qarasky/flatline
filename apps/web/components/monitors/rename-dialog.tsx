"use client";

import { useState, type FormEvent } from "react";

import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input } from "@qarasky/kore-ui";

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
            <DialogContent size="sm" title={`Rename ${monitor.type === "group" ? "group" : "monitor"}`}>
                <form onSubmit={(e) => void save(e)} className="flex min-h-0 flex-col">
                    <DialogBody>
                        <Field label="Name" error={error}>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={saving}
                                autoFocus
                                maxLength={150}
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={saving}>
                            {saving ? "Saving…" : "Rename"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
