"use client";

import { useEffect, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogFooter,
    Field,
    Input,
    Menu,
    MenuContent,
    MenuItem as KoreMenuItem,
    MenuSeparator,
    MenuTrigger,
} from "@qarasky/kore-ui";
import type { MonitorSummary } from "@/lib/monitor-types";
import { updateMonitor } from "@/lib/monitors-api";
import { cleanMonitorName } from "@/lib/fleet-presentation";

export interface MenuAnchor {
    x: number;
    y: number;
    monitor: MonitorSummary;
}

export interface MenuItem {
    label: string;
    onSelect: () => void;
    /** Destructive actions read red and go last, after a separator. */
    danger?: boolean;
}

/**
 * Right-click / "More actions" menu for a server card: kore-ui's Menu,
 * anchored at a point (the pointer, or the card's ⋯ button). The caller
 * supplies the items; the menu only handles anchoring and dismissal.
 *
 * Radix closes it on Escape and outside pointer; scroll and resize close it
 * too, since the anchor point would no longer match. Focus lands on the
 * first item when it opens so keyboard operators are not stranded.
 */
export function ServerMenu({ anchor, items, onClose }: { anchor: MenuAnchor; items: MenuItem[]; onClose: () => void }) {
    const content = useRef<HTMLDivElement>(null);

    // Radix focuses the panel itself; put focus on the first item, as a
    // keyboard-opened menu does, once it has mounted.
    useEffect(() => {
        const frame = window.requestAnimationFrame(() =>
            content.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
        );
        return () => window.cancelAnimationFrame(frame);
    }, [anchor]);

    useEffect(() => {
        const onDismiss = () => onClose();
        window.addEventListener("scroll", onDismiss, true);
        window.addEventListener("resize", onDismiss);
        return () => {
            window.removeEventListener("scroll", onDismiss, true);
            window.removeEventListener("resize", onDismiss);
        };
    }, [onClose]);

    const regular = items.filter((item) => !item.danger);
    const destructive = items.filter((item) => item.danger);
    const render = (item: MenuItem) => (
        <KoreMenuItem key={item.label} danger={item.danger} onSelect={() => item.onSelect()}>
            {item.label}
        </KoreMenuItem>
    );

    return (
        <Menu
            open
            modal={false}
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                }
            }}
        >
            {/* A zero-size point the menu anchors to; Radix keeps it on screen. */}
            <MenuTrigger asChild>
                <span
                    aria-hidden="true"
                    className="pointer-events-none fixed size-0"
                    style={{ left: anchor.x, top: anchor.y }}
                />
            </MenuTrigger>
            <MenuContent
                aria-label={`Actions for ${anchor.monitor.name || "server"}`}
                onContextMenu={(e) => e.preventDefault()}
                ref={content}
                // The anchor is not focusable: leave focus where the operator was.
                onCloseAutoFocus={(e) => e.preventDefault()}
            >
                {regular.map(render)}
                {regular.length > 0 && destructive.length > 0 ? <MenuSeparator /> : null}
                {destructive.map(render)}
            </MenuContent>
        </Menu>
    );
}

/**
 * Rename dialog for a server card. The name edited here is the monitor's
 * display name (the card title prefers it over the agent-reported
 * hostname); hostnames themselves stay agent-owned and read-only.
 *
 * Saving PATCHes the monitor. The server broadcasts an invalidate and
 * every connected board resnapshots, so no local roster surgery is
 * needed — the dialog just closes and the new name lands.
 */
export function RenameDialog({
    monitor,
    currentName,
    onClose,
}: {
    monitor: MonitorSummary;
    currentName: string;
    onClose: () => void;
}) {
    const [name, setName] = useState(currentName);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save(e?: { preventDefault: () => void }) {
        e?.preventDefault();
        const next = cleanMonitorName(name);
        if (!next) {
            setError("Enter a name.");
            return;
        }
        if (next === currentName) {
            onClose();
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await updateMonitor(monitor.id, { name: next });
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't rename the server. Try again.");
            setSaving(false);
        }
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !saving) {
                    onClose();
                }
            }}
        >
            <DialogContent
                size="sm"
                title={`Rename “${currentName}”`}
                description="Card titles prefer this over the agent-reported hostname."
            >
                <form className="flex min-h-0 flex-col" onSubmit={(e) => void save(e)}>
                    <DialogBody>
                        <Field label="Display name" error={error}>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={saving}
                                maxLength={255}
                                autoFocus
                                autoComplete="off"
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button disabled={saving} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={saving}>
                            {saving ? "Saving…" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
