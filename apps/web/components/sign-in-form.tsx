"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AuthScreen, Button, Field, Input } from "@qarasky/kore-ui";

import { api } from "@/lib/api";
import { KORE_NAMES } from "@/lib/kore";
import { createSession, keepMigrating, migrateLegacyToken, signInMessage } from "@/lib/legacy-token";
import { passwordProblem } from "@/lib/password";
import { safeNext } from "@/lib/safe-next";
import { PASSWORD_PATH } from "@/lib/session";
import { LOCAL_ONLY, type SignInMethods, ssoErrorMessage, ssoStartHref, toMethods } from "@/lib/sso";

/** Email and password (the usual way), a token (the wall TV, recovery), or the first account. */
type Mode = "password" | "token" | "setup";

export function SignInForm({
    next,
    expired,
    ssoError,
}: {
    next: string | null;
    expired: boolean;
    ssoError: string | null;
}) {
    const router = useRouter();
    const [migrating, setMigrating] = useState(true);
    const [mode, setMode] = useState<Mode>("password");
    const [setupNeeded, setSetupNeeded] = useState(false);
    // Which methods this instance allows; null until the backend has said.
    const [methods, setMethods] = useState<SignInMethods | null>(null);
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

    // Kore ID, email and password, and tokens can each be switched off.
    useEffect(() => {
        if (migrating) {
            return;
        }
        api<Record<string, unknown>>("/api/v1/auth/sso/config")
            .then((answer) => {
                const found = toMethods(answer);
                setMethods(found);
                if (!found.localLogin) {
                    setMode(found.tokenLogin ? "token" : "password");
                }
            })
            .catch(() => setMethods(LOCAL_ONLY));
    }, [migrating]);

    // A fresh install has no account yet: offer to create the first one.
    useEffect(() => {
        if (migrating || !methods?.localLogin) {
            return;
        }
        api<{ setupNeeded: boolean }>("/api/v1/auth/setup")
            .then((answer) => setSetupNeeded(answer.setupNeeded))
            .catch(() => setSetupNeeded(false));
    }, [migrating, methods]);

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

    /** The email + password form: kore-ui's AuthScreen runs it and shows "Signing in…". */
    async function signInWithPassword(values: { email: string; password: string }) {
        setError(null);
        try {
            const answer = await api<{ mustChangePassword: boolean }>("/api/v1/auth/session", {
                method: "POST",
                body: { email: values.email.trim(), password: values.password },
            });
            enter(answer.mustChangePassword);
        } catch (failure) {
            setError(signInMessage(failure));
        }
    }

    /** The operator-token form and first-account setup. */
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
            if (mode === "token") {
                await api("/api/v1/auth/session", { method: "POST", body: { token: token.trim() } });
            } else {
                await api("/api/v1/auth/setup", {
                    method: "POST",
                    body: { token: token.trim(), name: name.trim(), email: email.trim(), password },
                });
            }
            enter();
        } catch (failure) {
            setError(signInMessage(failure));
            setBusy(false);
        }
    }

    const shared = { app: "flatline" as const, names: KORE_NAMES };

    if (migrating || methods === null) {
        return <AuthScreen {...shared} description="Signing in…" />;
    }

    const canPassword = methods.localLogin;
    const canToken = methods.tokenLogin;
    const ssoMessage = ssoErrorMessage(ssoError);
    const sso = methods.sso ? { href: ssoStartHref(next) } : undefined;
    const notice = expired ? "Your session ended. Sign in again." : undefined;
    const noMethod = !methods.sso && !canPassword && !canToken;

    const switches = (
        <div className="flex flex-col items-center gap-1.5">
            {mode === "password" && canToken ? (
                <Button variant="link" onClick={() => switchTo("token")}>
                    Use an operator token instead
                </Button>
            ) : mode !== "password" && canPassword ? (
                <Button variant="link" onClick={() => switchTo("password")}>
                    Sign in with email and password
                </Button>
            ) : null}
            {setupNeeded && canPassword && mode !== "setup" ? (
                <Button variant="link" onClick={() => switchTo("setup")}>
                    Create the first account
                </Button>
            ) : null}
        </div>
    );

    if (mode === "password" || noMethod) {
        return (
            <AuthScreen
                {...shared}
                description={noMethod ? undefined : "Sign in to monitor your sites and servers."}
                sso={sso}
                password={canPassword ? { onSubmit: signInWithPassword, invalid: !!error } : undefined}
                error={(noMethod ? "No sign-in method is enabled on this instance." : null) ?? error ?? ssoMessage}
                notice={notice}
                footer={switches}
            />
        );
    }

    const invalid = error ? true : undefined;
    const ready =
        mode === "token"
            ? token.trim() !== ""
            : token.trim() !== "" && name.trim() !== "" && email.trim() !== "" && password !== "";

    return (
        <AuthScreen
            {...shared}
            title={mode === "setup" ? "Create the first account" : "Sign in"}
            description={
                mode === "setup"
                    ? "The operator token from the server proves this install is yours."
                    : "For wall screens and recovery."
            }
            sso={mode === "token" ? sso : undefined}
            error={error ?? (mode === "token" ? ssoMessage : null)}
            notice={notice}
            footer={switches}
        >
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Operator token" hint={mode === "token" ? "A flatline_op_ token." : undefined}>
                    <Input
                        type="password"
                        autoComplete="off"
                        autoFocus
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        aria-invalid={invalid}
                    />
                </Field>
                {mode === "setup" ? (
                    <>
                        <Field label="Your name">
                            <Input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
                        </Field>
                        <Field label="Email">
                            <Input
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                aria-invalid={invalid}
                            />
                        </Field>
                        <Field label="Password" hint="At least 10 characters.">
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                aria-invalid={invalid}
                            />
                        </Field>
                        <Field label="Repeat password">
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={confirm}
                                onChange={(event) => setConfirm(event.target.value)}
                                aria-invalid={invalid}
                            />
                        </Field>
                    </>
                ) : null}
                <Button
                    type="submit"
                    variant={sso && mode === "token" ? "secondary" : "primary"}
                    loading={busy}
                    disabled={!ready}
                >
                    {busy ? "Signing in…" : mode === "setup" ? "Create account" : "Sign in"}
                </Button>
            </form>
        </AuthScreen>
    );
}
