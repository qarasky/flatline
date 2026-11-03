"use client";

import { useState, type FormEvent } from "react";

import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Select, Textarea } from "@qarasky/kore-ui";
import { recordVerification } from "@/lib/backups-api";
import type { BackupRunSummary } from "@/lib/monitor-types";

/**
 * Record what an operator checked on a run: the archive itself, or an actual
 * restore. Agents cannot claim a restore; only this can.
 */
export function VerificationDialog({
    run,
    onClose,
    onDone,
}: {
    run: BackupRunSummary;
    onClose: () => void;
    onDone: () => void;
}) {
    const [kind, setKind] = useState<"archive" | "restore">("restore");
    const [status, setStatus] = useState<"passed" | "failed">("passed");
    const [summary, setSummary] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await recordVerification(run.id, {
                kind,
                status,
                checkedAt: new Date().toISOString(),
                summary: summary.trim(),
            });
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not record the verification.");
            setBusy(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                title="Record a verification"
                description={`For the run started ${run.exportStartedAt.slice(0, 16).replace("T", " ")} UTC.`}
            >
                <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
                    <DialogBody className="grid gap-4">
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="What was checked">
                                <Select
                                    value={kind}
                                    onValueChange={setKind}
                                    options={[
                                        { value: "restore", label: "A restore" },
                                        { value: "archive", label: "The archive" },
                                    ]}
                                />
                            </Field>
                            <Field label="Result">
                                <Select
                                    value={status}
                                    onValueChange={setStatus}
                                    options={[
                                        { value: "passed", label: "Passed" },
                                        { value: "failed", label: "Failed" },
                                    ]}
                                />
                            </Field>
                        </div>
                        <Field label="What you did" required>
                            <Textarea
                                value={summary}
                                onChange={(e) => setSummary(e.target.value)}
                                placeholder="Restored into a scratch container and ran the smoke queries."
                                rows={3}
                            />
                        </Field>
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
                        <Button type="submit" variant="primary" loading={busy} disabled={!summary.trim()}>
                            {busy ? "Saving…" : "Record"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
