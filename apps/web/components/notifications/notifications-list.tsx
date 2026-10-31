"use client";

import { Ellipsis, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deleteNotification, fetchNotificationList, type NotificationRecord } from "@/lib/notifications-api";
import { cn } from "@/lib/utils";

import { NotificationDialog } from "./notification-dialog";

type Editing = { record: NotificationRecord | null } | null;

/**
 * The notification configs: what each is, whether new monitors get it, and
 * which monitors alert through it (read-only here: a monitor's form picks its
 * notifications).
 */
export function NotificationsList() {
    const { monitors } = useBoardData();
    const [records, setRecords] = useState<NotificationRecord[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<Editing>(null);
    const [deleting, setDeleting] = useState<NotificationRecord | null>(null);
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState<Set<number>>(new Set());
    const names = new Map(monitors.map((m) => [m.id, m.name]));

    const load = useCallback(async () => {
        try {
            setRecords(await fetchNotificationList());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load the notifications.");
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);

    async function remove(record: NotificationRecord) {
        setBusy(true);
        try {
            await deleteNotification(record.id);
            setDeleting(null);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not delete the notification.");
            setDeleting(null);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section aria-label="Notifications" className="flex flex-1 flex-col">
            <div className="flex min-h-11 items-center border-b px-4 py-2">
                <span className="text-muted-foreground text-xs">
                    Telegram notifications. A monitor&apos;s form picks which it uses.
                </span>
                <Button size="sm" className="ml-auto" onClick={() => setEditing({ record: null })}>
                    <Plus />
                    New notification
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-status-down px-4 py-2 text-xs">
                    {error}
                </p>
            ) : null}
            {records === null ? (
                <p className="text-muted-foreground p-6">Loading…</p>
            ) : records.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-10">
                    <p className="text-muted-foreground">No notifications yet. Add one to get alerts in Telegram.</p>
                </div>
            ) : (
                <ul aria-label="Notification list">
                    {records.map((record) => {
                        const used = record.monitorIds;
                        const expanded = open.has(record.id);
                        return (
                            <li key={record.id} data-notification-id={record.id} className="border-b px-4 py-2.5">
                                <div className="flex items-center gap-3">
                                    <span className="min-w-0 truncate font-medium">{record.name}</span>
                                    <span
                                        className={cn(
                                            "text-xs",
                                            record.active ? "text-status-up" : "text-muted-foreground"
                                        )}
                                    >
                                        {record.active ? "On" : "Off"}
                                    </span>
                                    {record.isDefault ? (
                                        <span className="text-muted-foreground text-xs">ticked for new monitors</span>
                                    ) : null}
                                    <span className="text-muted-foreground text-xs tabular-nums">
                                        chat {String(record.config.telegramChatID ?? "—")}
                                    </span>
                                    <button
                                        type="button"
                                        className="text-muted-foreground hover:text-foreground ml-auto text-xs tabular-nums"
                                        aria-expanded={expanded}
                                        disabled={used.length === 0}
                                        onClick={() =>
                                            setOpen((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(record.id)) {
                                                    next.delete(record.id);
                                                } else {
                                                    next.add(record.id);
                                                }
                                                return next;
                                            })
                                        }
                                    >
                                        {used.length === 0
                                            ? "Used by no monitors"
                                            : `Used by ${used.length} monitor${used.length === 1 ? "" : "s"}`}
                                    </button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                aria-label={`Actions for ${record.name}`}
                                            >
                                                <Ellipsis />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onSelect={() => setEditing({ record })}>
                                                Edit…
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() => setDeleting(record)}
                                            >
                                                Delete…
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                                {expanded ? (
                                    <ul
                                        className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
                                        aria-label={`Monitors using ${record.name}`}
                                    >
                                        {used.map((id) => (
                                            <li key={id}>
                                                <Link href={`/monitors/${id}`} className="hover:underline">
                                                    {names.get(id) ?? `#${id}`}
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
            {editing ? (
                <NotificationDialog
                    record={editing.record}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void load();
                    }}
                />
            ) : null}
            <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete {deleting?.name}?</DialogTitle>
                        <DialogDescription>
                            {deleting && deleting.monitorIds.length > 0
                                ? `These monitors stop alerting through it: ${deleting.monitorIds.map((id) => names.get(id) ?? `#${id}`).join(", ")}.`
                                : "No monitor uses it."}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button variant="destructive" disabled={busy} onClick={() => deleting && void remove(deleting)}>
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
