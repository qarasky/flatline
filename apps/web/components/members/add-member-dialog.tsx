"use client";

import { Plus } from "lucide-react";
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
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { signInMessage as failureMessage } from "@/lib/legacy-token";
import { passwordProblem } from "@/lib/password";

/** Add a member with a starting password they change at first sign-in. */
export function AddMemberDialog() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function reset(next: boolean) {
        setOpen(next);
        if (!next) {
            setName("");
            setEmail("");
            setPassword("");
            setConfirm("");
            setError(null);
            setBusy(false);
        }
    }

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
            await api("/api/v1/users", {
                method: "POST",
                body: { name: name.trim(), email: email.trim(), password },
            });
            reset(false);
            router.refresh();
        } catch (failure) {
            setError(failureMessage(failure));
            setBusy(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={reset}>
            <DialogTrigger asChild>
                <Button size="sm">
                    <Plus />
                    Add member
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                    <DialogHeader>
                        <DialogTitle>Add member</DialogTitle>
                        <DialogDescription>
                            Give them the starting password yourself. They choose their own the first time they sign in;
                            an unused starting password expires after 7 days.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="member-name">Name</Label>
                        <Input
                            id="member-name"
                            autoComplete="off"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="member-email">Email</Label>
                        <Input
                            id="member-email"
                            type="email"
                            autoComplete="off"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="member-password">Starting password</Label>
                        <Input
                            id="member-password"
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="member-confirm">Repeat starting password</Label>
                        <Input
                            id="member-confirm"
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
                        <Button
                            type="submit"
                            disabled={busy || name.trim() === "" || email.trim() === "" || password === ""}
                        >
                            {busy ? "Adding…" : "Add member"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
