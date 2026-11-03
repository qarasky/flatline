"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input } from "@qarasky/kore-ui";
import { api } from "@/lib/api";
import { signInMessage as failureMessage } from "@/lib/legacy-token";
import type { Member } from "@/lib/members";
import { passwordProblem } from "@/lib/password";

/** Give a member a new starting password; they are signed out everywhere. */
export function ResetPasswordDialog({ member, onClose }: { member: Member; onClose: () => void }) {
    const router = useRouter();
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        const problem = passwordProblem(password, confirm);
        if (problem) {
            setError(problem);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api(`/api/v1/users/${member.id}/reset-password`, { method: "POST", body: { password } });
            onClose();
            router.refresh();
        } catch (failure) {
            setError(failureMessage(failure));
            setBusy(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                title={`Reset ${member.name}’s password`}
                description="They are signed out everywhere now and choose their own password the next time they sign in with this one."
            >
                <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="New starting password" hint="At least 10 characters.">
                            <Input
                                type="password"
                                autoComplete="new-password"
                                autoFocus
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                aria-invalid={error ? true : undefined}
                            />
                        </Field>
                        <Field label="Repeat it">
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(event) => setConfirm(event.target.value)}
                                aria-invalid={error ? true : undefined}
                            />
                        </Field>
                        {error && (
                            <p role="alert" className="text-meta text-danger">
                                {error}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button onClick={onClose}>Cancel</Button>
                        <Button type="submit" variant="primary" loading={busy} disabled={password === ""}>
                            {busy ? "Resetting…" : "Reset password"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
