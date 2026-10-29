"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { createSession, keepMigrating, migrateLegacyToken, signInMessage } from "@/lib/legacy-token";
import { passwordProblem } from "@/lib/password";
import { safeNext } from "@/lib/safe-next";
import { PASSWORD_PATH } from "@/lib/session";

/** Email and password (the usual way), a token (the wall TV, recovery), or the first account. */
type Mode = "password" | "token" | "setup";

export function SignInForm({ next, expired }: { next: string | null; expired: boolean }) {
    const router = useRouter();
    const [migrating, setMigrating] = useState(true);
    const [mode, setMode] = useState<Mode>("password");
    const [setupNeeded, setSetupNeeded] = useState(false);
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const started = useRef(false);

    const enter = (mustChangePassword = false) => {
        router.replace(mustChangePassword ? PASSWORD_PATH : safeNext(next));
        router.refresh();
    };

    const switchTo = (to: Mode) => {
        setMode(to);
        setError(null);
    };

    // A fresh install has no account yet: offer to create the first one.
    useEffect(() => {
        if (migrating) {
            return;
        }
        api<{ setupNeeded: boolean }>("/api/v1/auth/setup")
            .then((answer) => setSetupNeeded(answer.setupNeeded))
            .catch(() => setSetupNeeded(false));
    }, [migrating]);

    // A browser the old dashboard signed in (the wall TV) still holds its
    // token in localStorage: swap it for a session without asking. If
    // Flatline cannot be reached yet, show the form and keep retrying in the
    // background, so a screen nobody sits at still signs itself in.
    useEffect(() => {
        if (started.current) {
            return;
        }
        started.current = true;
        const controller = new AbortController();
        const deps = { storage: window.localStorage, createSession };
        void migrateLegacyToken(deps).then(async (result) => {
            if (result === "migrated") {
                enter();
                return;
            }
            setMigrating(false);
            if (result !== "error") {
                return;
            }
            const wait = (ms: number) =>
                new Promise<void>((resolve) => {
                    const timer = window.setTimeout(resolve, ms);
                    controller.signal.addEventListener("abort", () => {
                        window.clearTimeout(timer);
                        resolve();
                    });
                });
            if ((await keepMigrating({ ...deps, wait, signal: controller.signal })) === "migrated") {
                enter();
            }
        });
        return () => {
            // Stop retrying when the page goes away. React's development
            // double mount also lands here; the second mount starts again.
            controller.abort();
            started.current = false;
        };
    }, []);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (mode === "setup") {
            const problem = passwordProblem(password, confirm);
            if (problem) {
                setError(problem);
                return;
            }
        }
        setBusy(true);
        setError(null);
        try {
            if (mode === "password") {
                const answer = await api<{ mustChangePassword: boolean }>("/api/v1/auth/session", {
                    method: "POST",
                    body: { email: email.trim(), password },
                });
                enter(answer.mustChangePassword);
            } else if (mode === "token") {
                await api("/api/v1/auth/session", { method: "POST", body: { token: token.trim() } });
                enter();
            } else {
                await api("/api/v1/auth/setup", {
                    method: "POST",
                    body: { token: token.trim(), name: name.trim(), email: email.trim(), password },
                });
                enter();
            }
        } catch (failure) {
            setError(signInMessage(failure));
            setBusy(false);
        }
    }

    if (migrating) {
        return <p className="text-muted-foreground">Signing in…</p>;
    }

    const ready =
        mode === "password"
            ? email.trim() !== "" && password !== ""
            : mode === "token"
              ? token.trim() !== ""
              : token.trim() !== "" && name.trim() !== "" && email.trim() !== "" && password !== "";
    const invalid = error ? true : undefined;

    return (
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5" noValidate>
            <div className="flex items-center gap-2.5">
                <img src="/icon.svg" alt="" width={28} height={28} />
                <span className="text-lg font-semibold tracking-tight">Flatline</span>
            </div>

            {expired && <p className="text-muted-foreground">Your session ended. Sign in again.</p>}
            {mode === "setup" && (
                <p className="text-muted-foreground">
                    Create the first account. The operator token from the server proves this install is yours.
                </p>
            )}

            {(mode === "token" || mode === "setup") && (
                <div className="flex flex-col gap-2">
                    <Label htmlFor="token">Operator token</Label>
                    <Input
                        id="token"
                        type="password"
                        autoComplete="off"
                        autoFocus
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        aria-invalid={invalid}
                        aria-describedby="form-help"
                    />
                </div>
            )}

            {mode === "setup" && (
                <div className="flex flex-col gap-2">
                    <Label htmlFor="name">Your name</Label>
                    <Input
                        id="name"
                        autoComplete="name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
            )}

            {(mode === "password" || mode === "setup") && (
                <>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="email">Email</Label>
                        <Input
                            id="email"
                            type="email"
                            autoComplete={mode === "setup" ? "email" : "username"}
                            autoFocus={mode === "password"}
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            aria-invalid={invalid}
                            aria-describedby="form-help"
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="password">Password</Label>
                        <Input
                            id="password"
                            type="password"
                            autoComplete={mode === "setup" ? "new-password" : "current-password"}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            aria-invalid={invalid}
                            aria-describedby="form-help"
                        />
                    </div>
                </>
            )}

            {mode === "setup" && (
                <div className="flex flex-col gap-2">
                    <Label htmlFor="confirm">Repeat password</Label>
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
            )}

            {error ? (
                <p id="form-help" role="alert" className="text-status-down">
                    {error}
                </p>
            ) : mode === "token" ? (
                <p id="form-help" className="text-muted-foreground">
                    Paste a <code className="font-mono">flatline_op_</code> token.
                </p>
            ) : mode === "setup" ? (
                <p id="form-help" className="text-muted-foreground">
                    At least 10 characters.
                </p>
            ) : null}

            <Button type="submit" disabled={busy || !ready}>
                {busy ? "Signing in…" : mode === "setup" ? "Create account" : "Sign in"}
            </Button>

            <div className="text-muted-foreground flex flex-col items-start gap-1.5">
                {mode === "password" ? (
                    <button type="button" className="hover:text-foreground" onClick={() => switchTo("token")}>
                        Use a token instead
                    </button>
                ) : (
                    <button type="button" className="hover:text-foreground" onClick={() => switchTo("password")}>
                        Sign in with email and password
                    </button>
                )}
                {setupNeeded && mode !== "setup" && (
                    <button type="button" className="hover:text-foreground" onClick={() => switchTo("setup")}>
                        Create the first account
                    </button>
                )}
            </div>
        </form>
    );
}
