import { useEffect, useRef, useState } from "react";
import { ApiError, updateMonitor, type MonitorSummary } from "@/lib/api";
import { clampMenuPosition, cleanMonitorName } from "@/lib/fleet-presentation";
import type { GroupOption } from "@/lib/groups";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

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
 * Move a monitor (or group) into another group, or back to the top level.
 * PATCHing `parent` broadcasts an invalidate, so every open board and the
 * table resnapshot on their own.
 */
export function MoveDialog({
    monitor,
    options,
    currentParent,
    onClose,
}: {
    monitor: MonitorSummary;
    options: GroupOption[];
    currentParent: number | null;
    onClose: () => void;
}) {
    const [parent, setParent] = useState(currentParent != null ? String(currentParent) : "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save(e?: { preventDefault: () => void }) {
        e?.preventDefault();
        setSaving(true);
        setError(null);
        try {
            await updateMonitor(monitor.id, { parent: parent ? Number(parent) : null });
            onClose();
        } catch (err) {
            setError(
                err instanceof ApiError && err.status === 403
                    ? "This board token can't move monitors (needs write scope)."
                    : err instanceof Error
                      ? err.message
                      : "Move failed."
            );
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
                aria-label={`Move ${monitor.name}`}
                className="w-full max-w-sm rounded-lg border border-border bg-card p-5"
                onSubmit={(e) => void save(e)}
            >
                <h2 className="mb-1 text-base font-semibold">Move to group</h2>
                <p className="mb-3 text-xs text-quiet">Where should “{monitor.name}” live in the tree?</p>
                <label className="mb-1 block text-xs text-quiet" htmlFor="monitor-move-select">
                    Group
                </label>
                <Select
                    id="monitor-move-select"
                    value={parent}
                    disabled={saving}
                    autoFocus
                    onChange={setParent}
                    className="mb-3 h-9"
                    options={[{ value: "", label: "— none (top level)" }, ...options]}
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
                        {saving ? "Moving…" : "Move"}
                    </button>
                </div>
            </form>
        </div>
    );
}

/**
 * Delete a group. Two modes: keep the contents (children move up to the
 * group's parent, so the tree never orphans anything) or purge the whole
 * subtree in one request. The counts come from the caller's roster.
 */
export function DeleteGroupDialog({
    group,
    rows,
    children,
    parentName,
    onDelete,
    onClose,
}: {
    group: MonitorSummary;
    /** Non-group monitors in the whole subtree. */
    rows: number;
    /** Direct children (groups and monitors). */
    children: number;
    /** Where kept children land, for the explanation. */
    parentName: string | null;
    onDelete: (mode: "keep" | "purge") => void | Promise<void>;
    onClose: () => void;
}) {
    const [purge, setPurge] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    async function submit(e?: { preventDefault: () => void }) {
        e?.preventDefault();
        setBusy(true);
        try {
            await onDelete(purge ? "purge" : "keep");
        } finally {
            setBusy(false);
        }
    }

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
                aria-label={`Delete group ${group.name}`}
                className="w-full max-w-md rounded-lg border border-border bg-card p-5"
                onSubmit={(e) => void submit(e)}
            >
                <h2 className="mb-1 text-base font-semibold">Delete group “{group.name}”</h2>
                <p className="mb-3 text-xs text-quiet">
                    {children} direct {children === 1 ? "child" : "children"} · {rows}{" "}
                    {rows === 1 ? "monitor" : "monitors"} inside the whole subtree.
                </p>
                <label className="mb-3 flex items-start gap-2 text-sm">
                    <Checkbox
                        checked={purge}
                        disabled={busy}
                        onChange={(e) => setPurge(e.target.checked)}
                        className="mt-0.5"
                    />
                    <span>
                        Also delete everything inside
                        <span className="block text-[11px] text-quiet">
                            Unchecked, the {children} direct {children === 1 ? "child moves" : "children move"} up to{" "}
                            {parentName ?? "the top level"} and nothing is lost.
                        </span>
                    </span>
                </label>
                {purge && rows > 0 ? (
                    <p className="mb-3 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive" role="alert">
                        {rows} {rows === 1 ? "monitor" : "monitors"} will be deleted with their history. This cannot be
                        undone.
                    </p>
                ) : null}
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onClose}
                        className="rounded-md px-3 py-1.5 text-sm text-quiet hover:text-primary"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md bg-destructive px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                        {busy ? "Deleting…" : purge ? `Delete group + ${rows}` : "Delete group"}
                    </button>
                </div>
            </form>
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
            setError(
                err instanceof ApiError && err.status === 403
                    ? "This board token can't rename (needs write scope). Reconnect with a write token."
                    : err instanceof Error
                      ? err.message
                      : "Rename failed."
            );
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
