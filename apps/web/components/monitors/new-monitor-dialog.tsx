"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { MonitorForm, type FormInitial } from "./monitor-form";

/** Query keys that open the create dialog: `new=1`, optionally `parent=ID` and `type=group`. */
export const NEW_KEYS = ["new", "parent", "type"] as const;

/** The presets `?new=1&parent=ID&type=group` ask for, or null when the dialog is closed. */
export function newMonitorPresets(params: URLSearchParams): FormInitial | null {
    if (params.get("new") !== "1") {
        return null;
    }
    const presets: FormInitial = {};
    const parent = Number(params.get("parent"));
    if (Number.isInteger(parent) && parent > 0) {
        presets.parent = parent;
    }
    if (params.get("type") === "group") {
        presets.type = "group";
    }
    return presets;
}

/** Open or close the create dialog in place: the URL changes, nothing is fetched. */
export function setNewMonitorParams(presets: FormInitial | null): void {
    const url = new URL(window.location.href);
    for (const key of NEW_KEYS) {
        url.searchParams.delete(key);
    }
    if (presets) {
        url.searchParams.set("new", "1");
        if (typeof presets.parent === "number") {
            url.searchParams.set("parent", String(presets.parent));
        }
        if (presets.type === "group") {
            url.searchParams.set("type", "group");
        }
    }
    window.history.replaceState(null, "", url);
}

/** The header's New monitor button. */
export function NewMonitorButton() {
    return (
        <Button size="sm" onClick={() => setNewMonitorParams({})}>
            <Plus />
            New monitor
        </Button>
    );
}

/** Create in a modal (Plane's pattern); edit happens in the peek or on the full page. */
export function NewMonitorDialog({
    presets,
    onClose,
    onSaved,
}: {
    presets: FormInitial | null;
    onClose: () => void;
    onSaved: (id: number) => void;
}) {
    return (
        <Dialog open={presets !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{presets?.type === "group" ? "New group" : "New monitor"}</DialogTitle>
                    <DialogDescription>HTTP, ping and push monitors, and groups to organise them.</DialogDescription>
                </DialogHeader>
                {presets ? <MonitorForm initial={presets} onSaved={onSaved} onCancel={onClose} /> : null}
            </DialogContent>
        </Dialog>
    );
}
