"use client";

import { useState, type FormEvent } from "react";

import { Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input } from "@qarasky/kore-ui";

import { notificationBody, notificationValues, type NotificationValues } from "@/lib/notification-form";
import { createNotification, updateNotification, type NotificationRecord } from "@/lib/notifications-api";

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
            setError(e instanceof Error ? e.message : "Couldn't save the notification. Try again.");
            setBusy(false);
        }
    }

    const ready =
        values.name.trim() !== "" && values.chatId.trim() !== "" && (editing || values.botToken.trim() !== "");
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                size="lg"
                title={editing ? `Edit “${record.name}”` : "New Telegram notification"}
                description="Alerts go to a Telegram chat through your bot."
            >
                <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Name" required>
                            <Input value={values.name} onChange={(e) => set("name", e.target.value)} />
                        </Field>
                        <Field
                            label="Bot token"
                            required={!editing}
                            hint={editing ? "Leave empty to keep the current token." : undefined}
                        >
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={values.botToken}
                                onChange={(e) => set("botToken", e.target.value)}
                                placeholder={editing ? undefined : "123456:ABC…"}
                            />
                        </Field>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <Field label="Chat id" required>
                                <Input
                                    value={values.chatId}
                                    onChange={(e) => set("chatId", e.target.value)}
                                    placeholder="-100…"
                                />
                            </Field>
                            <Field label="Topic id" hint="Optional.">
                                <Input value={values.threadId} onChange={(e) => set("threadId", e.target.value)} />
                            </Field>
                        </div>
                        <div className="flex flex-col gap-1">
                            <Checkbox
                                label="Active"
                                checked={values.active}
                                onCheckedChange={(c) => set("active", c === true)}
                            />
                            <Checkbox
                                label="Ticked for new monitors"
                                checked={values.isDefault}
                                onCheckedChange={(c) => set("isDefault", c === true)}
                            />
                            <Checkbox
                                label="Send silently"
                                checked={values.silent}
                                onCheckedChange={(c) => set("silent", c === true)}
                            />
                            <Checkbox
                                label="Protect content"
                                description="Recipients can't forward or save the alerts."
                                checked={values.protect}
                                onCheckedChange={(c) => set("protect", c === true)}
                            />
                        </div>
                        {error ? (
                            <p role="alert" className="text-meta text-danger">
                                {error}
                            </p>
                        ) : null}
                    </DialogBody>
                    <DialogFooter>
                        <Button onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
                            {busy ? "Saving…" : editing ? "Save" : "Create notification"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
