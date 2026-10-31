"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notificationBody, notificationValues, type NotificationValues } from "@/lib/notification-form";
import { createNotification, updateNotification, type NotificationRecord } from "@/lib/notifications-api";

function Toggle({
    id,
    label,
    checked,
    onChange,
}: {
    id: string;
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <label htmlFor={id} className="flex items-center gap-2">
            <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} />
            {label}
        </label>
    );
}

/** Create a Telegram notification, or edit one (an empty bot token keeps the stored one). */
export function NotificationDialog({
    record,
    onClose,
    onSaved,
}: {
    /** The notification being edited; null to create one. */
    record: NotificationRecord | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const editing = record !== null;
    const [values, setValues] = useState<NotificationValues>(() => notificationValues(record));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const set = <K extends keyof NotificationValues>(key: K, value: NotificationValues[K]) =>
        setValues((prev) => ({ ...prev, [key]: value }));

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const body = notificationBody(values, record);
            if (record) {
                await updateNotification(record.id, body);
            } else {
                await createNotification(body);
            }
            onSaved();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save the notification.");
            setBusy(false);
        }
    }

    const ready =
        values.name.trim() !== "" && values.chatId.trim() !== "" && (editing || values.botToken.trim() !== "");
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <form onSubmit={(e) => void submit(e)} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>{editing ? `Edit ${record.name}` : "New Telegram notification"}</DialogTitle>
                        <DialogDescription>Alerts go to a Telegram chat through your bot.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1.5">
                        <Label htmlFor="notification-name">Name</Label>
                        <Input
                            id="notification-name"
                            value={values.name}
                            onChange={(e) => set("name", e.target.value)}
                            required
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="notification-token">Bot token</Label>
                        <Input
                            id="notification-token"
                            type="password"
                            autoComplete="new-password"
                            value={values.botToken}
                            onChange={(e) => set("botToken", e.target.value)}
                            placeholder={editing ? "Leave empty to keep the current token" : "123456:ABC…"}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="notification-chat">Chat id</Label>
                            <Input
                                id="notification-chat"
                                value={values.chatId}
                                onChange={(e) => set("chatId", e.target.value)}
                                placeholder="-100…"
                                required
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="notification-thread">Topic id (optional)</Label>
                            <Input
                                id="notification-thread"
                                value={values.threadId}
                                onChange={(e) => set("threadId", e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="grid gap-2">
                        <Toggle
                            id="notification-active"
                            label="Active"
                            checked={values.active}
                            onChange={(v) => set("active", v)}
                        />
                        <Toggle
                            id="notification-default"
                            label="Ticked for new monitors"
                            checked={values.isDefault}
                            onChange={(v) => set("isDefault", v)}
                        />
                        <Toggle
                            id="notification-silent"
                            label="Send silently"
                            checked={values.silent}
                            onChange={(v) => set("silent", v)}
                        />
                        <Toggle
                            id="notification-protect"
                            label="Protect content (no forwarding)"
                            checked={values.protect}
                            onChange={(v) => set("protect", v)}
                        />
                    </div>
                    {error ? (
                        <p role="alert" className="text-status-down text-xs">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !ready}>
                            {busy ? "Saving…" : editing ? "Save" : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
