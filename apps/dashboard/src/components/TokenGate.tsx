import { useState } from "react";
import type { SyntheticEvent } from "react";
import { ApiError, login, setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeviceSignIn } from "@/components/DeviceSignIn";

function errorMessage(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
        // The API's `hint` names the fix (e.g. "agent tokens are not operator
        // tokens, mint one in Agents"); show it instead of a bare 401.
        return e.hint ? `${e.message} ${e.hint}` : e.message;
    }
    return e instanceof Error ? e.message : fallback;
}

/**
 * Operator sign-in.
 *
 * Flatline is a single-operator instance: the credential is an operator token
 * — the one the server writes to `initial-token.txt` on first boot, or any
 * token minted in the Agents panel. It is exchanged for a bearer token held by
 * this browser. There are no accounts or invites. A screen without a keyboard
 * can instead show a QR code that a signed-in phone approves; that screen then
 * gets its own token. Pasting a token stays available as the fallback.
 */
export function TokenGate({ onSaved, pasteFirst = false }: { onSaved: () => void; pasteFirst?: boolean }) {
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The phone that approves a screen cannot scan itself, so it starts on paste.
    const [pasting, setPasting] = useState(pasteFirst);

    async function submit(event: SyntheticEvent) {
        event.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const res = await login({ password: value.trim() });
            setToken(res.token);
            onSaved();
        } catch (e) {
            setError(errorMessage(e, "Could not reach the Flatline server."));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
                <h1 className="m-0 text-base font-semibold">Flatline</h1>

                {pasting ? (
                    <form onSubmit={submit}>
                        <p className="mt-1 mb-4 text-xs text-muted-foreground">
                            Sign in with your operator token. It stays in this browser and is sent as a bearer token.
                        </p>

                        {error ? (
                            <div className="mb-3 rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">
                                {error}
                            </div>
                        ) : null}

                        <label className="mb-3 block">
                            <span className="mb-1 block text-xs text-muted-foreground">Operator token</span>
                            <Input
                                type="password"
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                autoComplete="current-password"
                                autoFocus
                                required
                            />
                        </label>

                        <Button type="submit" className="mt-1 w-full" disabled={busy}>
                            {busy ? "…" : "Sign in"}
                        </Button>
                    </form>
                ) : (
                    <>
                        <p className="mt-1 mb-4 text-xs text-muted-foreground">Sign in to Flatline</p>
                        <DeviceSignIn onSaved={onSaved} />
                    </>
                )}

                <button
                    type="button"
                    onClick={() => setPasting((p) => !p)}
                    className="mt-4 block w-full cursor-pointer border-0 bg-transparent p-0 text-center text-xs text-muted-foreground underline"
                >
                    {pasting ? "Sign in with a QR code instead" : "Paste a token instead"}
                </button>
            </div>
        </div>
    );
}
