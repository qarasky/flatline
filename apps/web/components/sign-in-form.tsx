"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { createSession, keepMigrating, migrateLegacyToken, signInMessage } from "@/lib/legacy-token";
import { safeNext } from "@/lib/safe-next";

export function SignInForm({ next, expired }: { next: string | null; expired: boolean }) {
    const router = useRouter();
    const [migrating, setMigrating] = useState(true);
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const started = useRef(false);

    const enter = () => {
        router.replace(safeNext(next));
        router.refresh();
    };

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
        setBusy(true);
        setError(null);
        try {
            await api("/api/v1/auth/session", { method: "POST", body: { token: token.trim() } });
            enter();
        } catch (failure) {
            setError(signInMessage(failure));
            setBusy(false);
        }
    }

    if (migrating) {
        return <p className="text-muted-foreground">Signing in…</p>;
    }

    return (
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5">
            <div className="flex items-center gap-2.5">
                <img src="/icon.svg" alt="" width={28} height={28} />
                <span className="text-lg font-semibold tracking-tight">Flatline</span>
            </div>

            {expired && <p className="text-muted-foreground">Your session ended. Sign in again.</p>}

            <div className="flex flex-col gap-2">
                <Label htmlFor="token">Operator token</Label>
                <Input
                    id="token"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby="token-help"
                />
                {error ? (
                    <p id="token-help" role="alert" className="text-status-down">
                        {error}
                    </p>
                ) : (
                    <p id="token-help" className="text-muted-foreground">
                        Paste a <code className="font-mono">flatline_op_</code> token. Signing in with a QR code from a
                        screen comes with the kiosk.
                    </p>
                )}
            </div>

            <Button type="submit" disabled={busy || token.trim() === ""}>
                {busy ? "Signing in…" : "Sign in"}
            </Button>
        </form>
    );
}
