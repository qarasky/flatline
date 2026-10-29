"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { signInMessage } from "@/lib/legacy-token";
import { passwordProblem } from "@/lib/password";
import { HOME_PATH, SIGN_IN_PATH } from "@/lib/session";

/**
 * Change your own password. `required`: the account still has the starting
 * password someone else set, and nothing else works until it is changed.
 */
export function ChangePasswordForm({ email, required }: { email: string; required: boolean }) {
    const router = useRouter();
    const [current, setCurrent] = useState("");
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
            await api("/api/v1/auth/password", {
                method: "POST",
                body: { currentPassword: current, newPassword: password },
            });
            router.replace(HOME_PATH);
            router.refresh();
        } catch (failure) {
            setError(signInMessage(failure));
            setBusy(false);
        }
    }

    async function signOut() {
        try {
            await api("/api/v1/auth/session", { method: "DELETE" });
        } finally {
            router.replace(SIGN_IN_PATH);
            router.refresh();
        }
    }

    const invalid = error ? true : undefined;

    return (
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5" noValidate>
            <div className="flex items-center gap-2.5">
                <img src="/icon.svg" alt="" width={28} height={28} />
                <span className="text-lg font-semibold tracking-tight">Change password</span>
            </div>

            <p className="text-muted-foreground">
                {required ? "Choose your own password to continue." : "Your other browsers will be signed out."}
            </p>

            {/* Lets a password manager file the new password under the right account. */}
            <input type="email" autoComplete="username" value={email} readOnly hidden />

            <div className="flex flex-col gap-2">
                <Label htmlFor="current">{required ? "Starting password" : "Current password"}</Label>
                <Input
                    id="current"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    value={current}
                    onChange={(event) => setCurrent(event.target.value)}
                    aria-invalid={invalid}
                    aria-describedby="form-help"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={invalid}
                    aria-describedby="form-help"
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="confirm">Repeat new password</Label>
                <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    aria-invalid={invalid}
                    aria-describedby="form-help"
                />
            </div>

            {error ? (
                <p id="form-help" role="alert" className="text-status-down">
                    {error}
                </p>
            ) : (
                <p id="form-help" className="text-muted-foreground">
                    At least 10 characters.
                </p>
            )}

            <Button type="submit" disabled={busy || current === "" || password === ""}>
                {busy ? "Saving…" : "Change password"}
            </Button>

            <div className="text-muted-foreground">
                {required ? (
                    <button type="button" className="hover:text-foreground" onClick={() => void signOut()}>
                        Sign out
                    </button>
                ) : (
                    <Link href={HOME_PATH} className="hover:text-foreground">
                        Back to Flatline
                    </Link>
                )}
            </div>
        </form>
    );
}
