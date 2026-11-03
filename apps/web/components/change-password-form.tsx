"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthScreen, Button, Field, Input } from "@qarasky/kore-ui";

import { api } from "@/lib/api";
import { KORE_APP, KORE_NAMES } from "@/lib/kore";
import { signInMessage } from "@/lib/legacy-token";
import { passwordProblem } from "@/lib/password";
import { endSession } from "@/lib/sso";
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
        const providerLogout = await endSession();
        if (providerLogout) {
            window.location.assign(providerLogout);
            return;
        }
        router.replace(SIGN_IN_PATH);
        router.refresh();
    }

    const invalid = error ? true : undefined;

    return (
        <AuthScreen
            app={KORE_APP}
            names={KORE_NAMES}
            title="Change password"
            description={required ? "Choose your own password to continue." : "Your other browsers will be signed out."}
            error={error}
            footer={
                required ? (
                    <Button variant="link" className="text-muted hover:text-text" onClick={() => void signOut()}>
                        Sign out
                    </Button>
                ) : (
                    <Link href={HOME_PATH} className="hover:text-text">
                        Back to Flatline
                    </Link>
                )
            }
        >
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                {/* Lets a password manager file the new password under the right account. */}
                <input type="email" autoComplete="username" value={email} readOnly hidden />

                <Field id="current" label={required ? "Starting password" : "Current password"}>
                    <Input
                        type="password"
                        autoComplete="current-password"
                        autoFocus
                        value={current}
                        onChange={(event) => setCurrent(event.target.value)}
                        aria-invalid={invalid}
                    />
                </Field>
                <Field id="new-password" label="New password" hint="At least 10 characters.">
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        aria-invalid={invalid}
                    />
                </Field>
                <Field id="confirm" label="Repeat new password">
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(event) => setConfirm(event.target.value)}
                        aria-invalid={invalid}
                    />
                </Field>

                <Button
                    type="submit"
                    variant="primary"
                    fullWidth
                    loading={busy}
                    disabled={current === "" || password === ""}
                >
                    {busy ? "Saving…" : "Change password"}
                </Button>
            </form>
        </AuthScreen>
    );
}
