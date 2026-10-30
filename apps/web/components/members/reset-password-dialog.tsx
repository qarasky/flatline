"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
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
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                    <DialogHeader>
                        <DialogTitle>Reset {member.name}&apos;s password</DialogTitle>
                        <DialogDescription>
                            They are signed out everywhere now and choose their own password the next time they sign in
                            with this one.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="reset-password">New starting password</Label>
                        <Input
                            id="reset-password"
                            type="password"
                            autoComplete="new-password"
                            autoFocus
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="reset-confirm">Repeat it</Label>
                        <Input
                            id="reset-confirm"
                            type="password"
                            autoComplete="new-password"
                            value={confirm}
                            onChange={(event) => setConfirm(event.target.value)}
                        />
                    </div>
                    {error && (
                        <p role="alert" className="text-status-down">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || password === ""}>
                            {busy ? "Resetting…" : "Reset password"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
