"use client";

import {
    Badge,
    Button,
    ConfirmDialog,
    EmptyState,
    IconButton,
    Menu,
    MenuContent,
    MenuItem,
    MenuSeparator,
    MenuTrigger,
    Table,
    TableBody,
    TableCell,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TableRowHeader,
} from "@qarasky/kore-ui";
import { Bell, ChevronDown, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { deleteNotification, fetchNotificationList, type NotificationRecord } from "@/lib/notifications-api";

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
    // The record stays after the dialog closes, so its text holds while it fades out.
    const [deleting, setDeleting] = useState<NotificationRecord | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [open, setOpen] = useState<Set<number>>(new Set());
    const names = new Map(monitors.map((m) => [m.id, m.name]));

    const load = useCallback(async () => {
        try {
            setRecords(await fetchNotificationList());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't load the notifications. Reload the page to try again.");
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);

    async function remove(record: NotificationRecord) {
        try {
            await deleteNotification(record.id);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't delete the notification. Try again.");
        }
    }

    function toggleOpen(id: number) {
        setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    return (
        <section aria-label="Notifications" className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <p className="text-meta text-muted min-w-0 flex-1">
                    Telegram notifications. A monitor&apos;s form picks which it uses.
                </p>
                <Button variant="primary" size="sm" onClick={() => setEditing({ record: null })}>
                    <Plus />
                    New notification
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-meta text-danger">
                    {error}
                </p>
            ) : null}
            {records !== null && records.length === 0 ? (
                <EmptyState
                    icon={<Bell />}
                    title="No notifications yet"
                    description="Add one to get alerts in Telegram."
                />
            ) : (
                <Table caption="Notification list">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="max-sm:hidden">Chat</TableHead>
                            <TableHead>Used by</TableHead>
                            <TableHead className="w-12">
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {records === null ? (
                            <TableEmpty colSpan={5}>Loading…</TableEmpty>
                        ) : (
                            records.map((record) => {
                                const used = record.monitorIds;
                                const expanded = open.has(record.id);
                                return (
                                    <Fragment key={record.id}>
                                        <TableRow data-notification-id={record.id}>
                                            <TableRowHeader>
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <span className="max-w-72 truncate font-medium">{record.name}</span>
                                                    {record.isDefault ? (
                                                        <Badge tone="outline" title="Ticked for new monitors">
                                                            Default
                                                        </Badge>
                                                    ) : null}
                                                </div>
                                            </TableRowHeader>
                                            <TableCell>
                                                <Badge tone={record.active ? "success" : "neutral"}>
                                                    {record.active ? "On" : "Off"}
                                                </Badge>
                                            </TableCell>
                                            <TableCell muted className="tabular-nums max-sm:hidden">
                                                {String(record.config.telegramChatID ?? "—")}
                                            </TableCell>
                                            <TableCell muted>
                                                {used.length === 0 ? (
                                                    "No monitors"
                                                ) : (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-muted hover:text-text -ml-3 tabular-nums"
                                                        aria-expanded={expanded}
                                                        onClick={() => toggleOpen(record.id)}
                                                    >
                                                        {expanded ? <ChevronDown /> : <ChevronRight />}
                                                        {used.length} monitor{used.length === 1 ? "" : "s"}
                                                    </Button>
                                                )}
                                            </TableCell>
                                            <TableCell align="right">
                                                <Menu>
                                                    <MenuTrigger asChild>
                                                        <IconButton
                                                            label={`Actions for ${record.name}`}
                                                            icon={<MoreHorizontal />}
                                                        />
                                                    </MenuTrigger>
                                                    <MenuContent align="end">
                                                        <MenuItem
                                                            icon={<Pencil />}
                                                            onSelect={() => setEditing({ record })}
                                                        >
                                                            Edit…
                                                        </MenuItem>
                                                        <MenuSeparator />
                                                        <MenuItem
                                                            danger
                                                            icon={<Trash2 />}
                                                            onSelect={() => {
                                                                setDeleting(record);
                                                                setDeleteOpen(true);
                                                            }}
                                                        >
                                                            Delete…
                                                        </MenuItem>
                                                    </MenuContent>
                                                </Menu>
                                            </TableCell>
                                        </TableRow>
                                        {expanded ? (
                                            <TableRow className="h-auto">
                                                <TableCell colSpan={5} className="pt-0 pb-3">
                                                    <ul
                                                        className="text-sub flex flex-wrap gap-x-4 gap-y-1"
                                                        aria-label={`Monitors using ${record.name}`}
                                                    >
                                                        {used.map((id) => (
                                                            <li key={id}>
                                                                <Link
                                                                    href={`/monitors/${id}`}
                                                                    className="text-accent hover:underline"
                                                                >
                                                                    {names.get(id) ?? `#${id}`}
                                                                </Link>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </TableCell>
                                            </TableRow>
                                        ) : null}
                                    </Fragment>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
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
            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                danger
                title={`Delete “${deleting?.name ?? ""}”?`}
                description={
                    deleting && deleting.monitorIds.length > 0
                        ? `These monitors stop alerting through it: ${deleting.monitorIds.map((id) => names.get(id) ?? `#${id}`).join(", ")}.`
                        : "No monitor uses it."
                }
                confirmLabel="Delete"
                onConfirm={async () => {
                    if (deleting) {
                        await remove(deleting);
                    }
                }}
            />
        </section>
    );
}
