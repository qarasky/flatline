"use client";

import { useState, type FormEvent } from "react";

import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Select } from "@qarasky/kore-ui";

import { groupOptions } from "@/lib/groups";
import type { MonitorSummary } from "@/lib/monitor-types";
import { updateMonitor } from "@/lib/monitors-api";

/** Radix Select cannot hold an empty value: this stands for "top level". */
const TOP_LEVEL = "none";

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
    const [parent, setParent] = useState(monitor.parent != null ? String(monitor.parent) : TOP_LEVEL);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save(event: FormEvent) {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
            await updateMonitor(monitor.id, { parent: parent !== TOP_LEVEL ? Number(parent) : null });
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Move failed.");
            setSaving(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                size="sm"
                title="Move to group"
                description={`Where should “${monitor.name}” live in the tree?`}
            >
                <form onSubmit={(e) => void save(e)} className="flex min-h-0 flex-col">
                    <DialogBody>
                        <Field label="Group" error={error}>
                            <Select
                                value={parent}
                                disabled={saving}
                                onValueChange={setParent}
                                options={[
                                    { value: TOP_LEVEL, label: "None (top level)" },
                                    ...options.map((o) => ({ value: String(o.value), label: o.label })),
                                ]}
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={saving}>
                            {saving ? "Moving…" : "Move"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
