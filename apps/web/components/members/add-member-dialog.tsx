"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogTrigger, Field, Input } from "@qarasky/kore-ui";
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

    const invalid = error ? true : undefined;

    return (
        <Dialog open={open} onOpenChange={reset}>
            <DialogTrigger asChild>
                <Button variant="primary" size="sm">
                    <Plus />
                    Add member
                </Button>
            </DialogTrigger>
            <DialogContent
                title="Add member"
                description="Give them the starting password yourself. They choose their own the first time they sign in; an unused starting password expires after 7 days."
            >
                <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Name">
                            <Input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
                        </Field>
                        <Field label="Email">
                            <Input
                                type="email"
                                autoComplete="off"
                                placeholder="ana@example.com"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                            />
                        </Field>
                        <Field label="Starting password" hint="At least 10 characters.">
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                aria-invalid={invalid}
                            />
                        </Field>
                        <Field label="Repeat starting password">
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(event) => setConfirm(event.target.value)}
                                aria-invalid={invalid}
                            />
                        </Field>
                        {error && (
                            <p role="alert" className="text-meta text-danger">
                                {error}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button onClick={() => reset(false)}>Cancel</Button>
                        <Button
                            type="submit"
                            variant="primary"
                            loading={busy}
                            disabled={name.trim() === "" || email.trim() === "" || password === ""}
                        >
                            {busy ? "Adding…" : "Add member"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
