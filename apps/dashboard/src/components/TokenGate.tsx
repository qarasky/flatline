import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import {
    ApiError,
    checkInvite,
    createFirstAccount,
    fetchSetupStatus,
    login,
    redeemInvite,
    setToken,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function errorMessage(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
        return e.message;
    }
    return e instanceof Error ? e.message : fallback;
}

/**
 * Password form shared by sign-in, first-run setup and invite redemption.
 *
 * Sign-in hides the username unless the server asks for it (multiple
 * accounts, or a legacy account still to migrate) — see TokenGate. Setup and
 * invites always show it: those flows create accounts and need a unique name.
 */
function CredentialsForm({
    submitLabel,
    error,
    busy,
    showTotp,
    showUsername,
    onSubmit,
}: {
    submitLabel: string;
    error: string | null;
    busy: boolean;
    showTotp: boolean;
    showUsername: boolean;
    onSubmit: (username: string, password: string, totp: string) => void;
}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [totp, setTotp] = useState("");

    async function submit(event: SyntheticEvent) {
        event.preventDefault();
        onSubmit(username.trim(), password, totp.trim());
    }

    return (
        <form onSubmit={submit}>
            {error ? (
                <div className="mb-3 rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">{error}</div>
            ) : null}

            {showUsername ? (
                <label className="mb-3 block">
                    <span className="mb-1 block text-xs text-muted-foreground">Username</span>
                    <Input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        autoFocus={!showTotp}
                        required
                    />
                </label>
            ) : null}

            <label className="mb-3 block">
                <span className="mb-1 block text-xs text-muted-foreground">Password</span>
                <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={submitLabel === "Create account" ? "new-password" : "current-password"}
                    autoFocus={!showUsername && !showTotp}
                    required
                />
            </label>

            {showTotp ? (
                <label className="mb-3 block">
                    <span className="mb-1 block text-xs text-muted-foreground">Two-factor code</span>
                    <Input
                        value={totp}
                        onChange={(e) => setTotp(e.target.value)}
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        autoFocus
                        required
                    />
                </label>
            ) : null}

            <Button type="submit" className="mt-1 w-full" disabled={busy}>
                {busy ? "…" : submitLabel}
            </Button>
        </form>
    );
}

/**
 * Sign-in, first-run setup and invite redemption in one gate.
 *
 * The dashboard holds a bearer token, not a session cookie, so signing in
 * mints a token and stores it. Setup and invites are part of the same screen
 * because a fresh instance has no other entry point: setup creates the first
 * account, and everyone after that arrives on an invite link.
 */
export function TokenGate({ inviteToken, onSaved }: { inviteToken: string | null; onSaved: () => void }) {
    const [mode, setMode] = useState<"loading" | "login" | "setup" | "invite">("loading");
    const [setupNeeded, setSetupNeeded] = useState(false);
    const [inviteNote, setInviteNote] = useState<string | null>(null);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [totpRequired, setTotpRequired] = useState(false);
    // Sign-in normally shows only the password: the server resolves the
    // single account. It answers `username_required` when it can't (several
    // accounts, or a legacy account still to migrate), which reveals the
    // field rather than dead-ending the login.
    const [usernameRequired, setUsernameRequired] = useState(false);

    useEffect(() => {
        let alive = true;

        async function init() {
            // An invite link decides the mode on its own; anything else
            // depends on whether the instance has an account yet.
            if (inviteToken) {
                try {
                    const checked = await checkInvite(inviteToken);
                    if (!alive) {
                        return;
                    }
                    setInviteNote(checked.note);
                    setMode("invite");
                } catch (e) {
                    if (!alive) {
                        return;
                    }
                    setInviteError(errorMessage(e, "This invite link is not valid."));
                    setMode("invite");
                }
                return;
            }

            try {
                const status = await fetchSetupStatus();
                if (!alive) {
                    return;
                }
                setSetupNeeded(status.setupNeeded);
                setMode(status.setupNeeded ? "setup" : "login");
            } catch (e) {
                if (!alive) {
                    return;
                }
                // The backend is unreachable; the login form is still useful
                // because its error will say so.
                setError(errorMessage(e, "Could not reach the Flatline server."));
                setMode("login");
            }
        }

        void init();
        return () => {
            alive = false;
        };
    }, [ inviteToken ]);

    async function saveToken(token: string) {
        setToken(token);
        onSaved();
    }

    async function doLogin(username: string, password: string, totp: string) {
        setError(null);
        setBusy(true);
        try {
            const res = await login({ ...(username ? { username } : {}), password, ...(totp ? { totp } : {}) });
            await saveToken(res.token);
        } catch (e) {
            if (e instanceof ApiError && e.code === "two_factor_required") {
                setTotpRequired(true);
                setError("Two-factor code required — enter it below and sign in again.");
            } else if (e instanceof ApiError && e.code === "username_required") {
                setToken(null);
                setUsernameRequired(true);
                setError(e.message);
            } else {
                setToken(null);
                setError(errorMessage(e, "Could not reach the Flatline server."));
            }
        } finally {
            setBusy(false);
        }
    }

    async function doSetup(username: string, password: string) {
        setError(null);
        setBusy(true);
        try {
            await createFirstAccount({ username, password });
            const res = await login({ username, password });
            await saveToken(res.token);
        } catch (e) {
            setError(errorMessage(e, "Could not reach the Flatline server."));
        } finally {
            setBusy(false);
        }
    }

    async function doRedeem(username: string, password: string) {
        setError(null);
        setBusy(true);
        try {
            if (!inviteToken) {
                return;
            }
            const redeemed = await redeemInvite(inviteToken, { username, password });
            const res = await login({ username: redeemed.username, password });
            await saveToken(res.token);
        } catch (e) {
            setError(errorMessage(e, "Could not redeem this invite."));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
                <h1 className="m-0 text-base font-semibold">Flatline</h1>

                {mode === "loading" ? (
                    <p className="mt-1 text-xs text-muted-foreground">Connecting…</p>
                ) : mode === "setup" ? (
                    <>
                        <p className="mt-1 mb-4 text-xs text-muted-foreground">
                            No accounts exist yet. Create the first operator account.
                        </p>
                        <CredentialsForm submitLabel="Create account" error={error} busy={busy} showTotp={false} showUsername onSubmit={doSetup} />
                    </>
                ) : mode === "invite" ? (
                    <>
                        <p className="mt-1 mb-4 text-xs text-muted-foreground">
                            {inviteError ?? (
                                <>
                                    You were invited to Flatline{inviteNote ? ` (${inviteNote})` : ""}. Choose a
                                    username and password.
                                </>
                            )}
                        </p>
                        {inviteError ? (
                            <Button variant="outline" className="w-full" onClick={() => setMode(setupNeeded ? "setup" : "login")}>
                                Back to sign in
                            </Button>
                        ) : (
                            <CredentialsForm submitLabel="Accept invite" error={error} busy={busy} showTotp={false} showUsername onSubmit={doRedeem} />
                        )}
                    </>
                ) : (
                    <>
                        <p className="mt-1 mb-4 text-xs text-muted-foreground">
                            Sign in with your password. A token is minted for this browser.
                        </p>
                        <CredentialsForm submitLabel="Sign in" error={error} busy={busy} showTotp={totpRequired} showUsername={usernameRequired} onSubmit={doLogin} />
                    </>
                )}
            </div>
        </div>
    );
}
