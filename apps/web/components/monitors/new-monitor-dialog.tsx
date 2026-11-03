"use client";

import { Plus } from "lucide-react";

import { Button, Dialog, DialogBody, DialogContent } from "@qarasky/kore-ui";

import { withNewMonitorParams, type NewMonitorPresets } from "@/lib/new-monitor-url";

import { MonitorForm } from "./monitor-form";

/** Open or close the create dialog in place: the URL changes, nothing is fetched. */
export function setNewMonitorParams(presets: NewMonitorPresets | null): void {
    window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${withNewMonitorParams(window.location.search, presets)}`
    );
}

/** The header's New monitor button. */
export function NewMonitorButton() {
    return (
        <Button variant="primary" size="sm" onClick={() => setNewMonitorParams({})}>
            <Plus />
            New monitor
        </Button>
    );
}

export { newMonitorPresets } from "@/lib/new-monitor-url";

/** Create in a modal (Plane's pattern); edit happens in the peek or on the full page. */
export function NewMonitorDialog({
    presets,
    onClose,
    onSaved,
}: {
    presets: NewMonitorPresets | null;
    onClose: () => void;
    onSaved: (id: number) => void;
}) {
    return (
        <Dialog open={presets !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                size="lg"
                title={presets?.type === "group" ? "New group" : "New monitor"}
                description="HTTP, ping and push monitors, and groups to organise them."
            >
                <DialogBody className="pb-5">
                    {presets ? <MonitorForm initial={presets} onSaved={onSaved} onCancel={onClose} /> : null}
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
