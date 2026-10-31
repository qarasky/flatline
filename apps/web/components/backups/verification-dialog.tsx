"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
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
            <DialogContent className="sm:max-w-md">
                <form onSubmit={(e) => void submit(e)} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Record a verification</DialogTitle>
                        <DialogDescription>
                            For the run started {run.exportStartedAt.slice(0, 16).replace("T", " ")} UTC.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="verify-kind">What was checked</Label>
                            <NativeSelect
                                id="verify-kind"
                                className="w-full"
                                value={kind}
                                onChange={(e) => setKind(e.target.value as "archive" | "restore")}
                            >
                                <NativeSelectOption value="restore">A restore</NativeSelectOption>
                                <NativeSelectOption value="archive">The archive</NativeSelectOption>
                            </NativeSelect>
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="verify-status">Result</Label>
                            <NativeSelect
                                id="verify-status"
                                className="w-full"
                                value={status}
                                onChange={(e) => setStatus(e.target.value as "passed" | "failed")}
                            >
                                <NativeSelectOption value="passed">Passed</NativeSelectOption>
                                <NativeSelectOption value="failed">Failed</NativeSelectOption>
                            </NativeSelect>
                        </div>
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="verify-summary">What you did</Label>
                        <Textarea
                            id="verify-summary"
                            value={summary}
                            onChange={(e) => setSummary(e.target.value)}
                            placeholder="Restored into a scratch container and ran the smoke queries."
                            required
                            rows={3}
                        />
                    </div>
                    {error ? (
                        <p role="alert" className="text-bad text-xs">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !summary.trim()}>
                            {busy ? "Saving…" : "Record"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
