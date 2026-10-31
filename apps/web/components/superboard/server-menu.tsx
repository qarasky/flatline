"use client";

import { useEffect, useRef, useState } from "react";
import type { MonitorSummary } from "@/lib/monitor-types";
import { updateMonitor } from "@/lib/monitors-api";
import { clampMenuPosition, cleanMonitorName } from "@/lib/fleet-presentation";
import { Input } from "@/components/legacy-ui/input";

export interface MenuAnchor {
    x: number;
    y: number;
    monitor: MonitorSummary;
}

export interface MenuItem {
    label: string;
    onSelect: () => void;
    /** Destructive actions read red. */
    danger?: boolean;
}

/**
 * Custom right-click/⋯ menu for cards, monitor rows and group headers. The
 * caller supplies the items; the menu only handles anchoring, dismissal and
 * keyboard focus.
 *
 * Closes on Escape, outside pointer, scroll or resize. Focus lands on the
 * first item when the menu opens so keyboard operators are not stranded.
 */
export function ServerMenu({ anchor, items, onClose }: { anchor: MenuAnchor; items: MenuItem[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });

    useEffect(() => {
        const el = ref.current;
        if (el) {
            const rect = el.getBoundingClientRect();
            setPos(
                clampMenuPosition(anchor.x, anchor.y, rect.width, rect.height, window.innerWidth, window.innerHeight)
            );
            el.querySelector("button")?.focus();
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        const onPointer = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const onDismiss = () => onClose();
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onPointer);
        window.addEventListener("scroll", onDismiss, true);
        window.addEventListener("resize", onDismiss);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pointerdown", onPointer);
            window.removeEventListener("scroll", onDismiss, true);
            window.removeEventListener("resize", onDismiss);
        };
    }, [anchor, onClose]);

    return (
        <div
            ref={ref}
            role="menu"
            aria-label={`Actions for ${anchor.monitor.name || "server"}`}
            className="fixed z-50 min-w-44 rounded-md border border-border bg-card p-1 shadow-xl"
            style={{ left: pos.x, top: pos.y }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {items.map((item) => (
                <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-surface ${
                        item.danger ? "text-destructive hover:text-destructive" : "hover:text-primary"
                    }`}
                    onClick={() => item.onSelect()}
                >
                    {item.label}
                </button>
            ))}
        </div>
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
            setError("Name can't be empty.");
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
            setError(err instanceof Error ? err.message : "Rename failed.");
            setSaving(false);
        }
    }

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                    onClose();
                }
            }}
        >
            <form
                role="dialog"
                aria-modal="true"
                aria-label={`Rename ${currentName}`}
                className="w-full max-w-sm rounded-lg border border-border bg-card p-5"
                onSubmit={(e) => void save(e)}
            >
                <h2 className="mb-1 text-base font-semibold">Rename server</h2>
                <p className="mb-3 text-xs text-quiet">Card titles prefer this over the agent-reported hostname.</p>
                <label className="mb-1 block text-xs text-quiet" htmlFor="server-rename-input">
                    Display name
                </label>
                <Input
                    id="server-rename-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={saving}
                    maxLength={255}
                    autoFocus
                    autoComplete="off"
                    className="mb-3 h-9"
                />
                {error ? (
                    <p className="mb-3 text-xs text-bad" role="alert">
                        {error}
                    </p>
                ) : null}
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        disabled={saving}
                        onClick={onClose}
                        className="rounded-md px-3 py-1.5 text-sm text-quiet hover:text-primary"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={saving}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                        {saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
        </div>
    );
}
