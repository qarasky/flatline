import { useEffect, useState } from "react";
import {
    ApiError,
    approveDeviceRequest,
    denyDeviceRequest,
    getToken,
    lookupDeviceRequest,
    type DeviceRequestInfo,
} from "@/lib/api";
import { codeFromHash, hostMismatch } from "@/lib/device-auth";
import { TokenGate } from "@/components/TokenGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type View =
    | { kind: "loading" }
    | { kind: "ready"; info: DeviceRequestInfo }
    | { kind: "done"; message: string }
    | { kind: "failed"; message: string };

function describeAge(seconds: number): string {
    return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)} min ago`;
}

function failure(e: unknown): string {
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
        return "This request has expired or was already answered. Ask the screen to show a new QR code.";
    }
    return e instanceof Error ? e.message : "Could not reach the Flatline server.";
}

/**
 * The page a phone opens after scanning a screen's QR code.
 *
 * Without a stored token it shows the normal sign-in first and then carries
 * on: the code lives in the URL fragment, which sign-in does not touch.
 */
export function DeviceApprove() {
    const [authed, setAuthed] = useState(() => Boolean(getToken()));
    const [code] = useState(() => codeFromHash(window.location.hash));
    const [view, setView] = useState<View>({ kind: "loading" });
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!authed) {
            return;
        }
        if (!code) {
            setView({ kind: "failed", message: "This link has no request code. Scan the QR code on the screen again." });
            return;
        }
        let cancelled = false;
        lookupDeviceRequest(code)
            .then((info) => {
                if (!cancelled) {
                    setName(info.suggestedName);
                    setView({ kind: "ready", info });
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    setView({ kind: "failed", message: failure(e) });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [authed, code]);

    if (!authed) {
        return <TokenGate pasteFirst onSaved={() => setAuthed(true)} />;
    }

    async function answer(approve: boolean) {
        if (!code) {
            return;
        }
        setBusy(true);
        try {
            if (approve) {
                await approveDeviceRequest(code, name);
                setView({ kind: "done", message: "Signed in. The screen will continue on its own." });
            } else {
                await denyDeviceRequest(code);
                setView({ kind: "done", message: "Denied." });
            }
        } catch (e) {
            setView({ kind: "failed", message: failure(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
                <h1 className="m-0 text-base font-semibold">Approve this screen?</h1>

                {view.kind === "loading" ? <p className="mt-3 text-sm text-quiet">Loading…</p> : null}

                {view.kind === "done" || view.kind === "failed" ? (
                    <p
                        className={`mt-3 mb-0 text-sm ${view.kind === "failed" ? "text-destructive" : ""}`}
                        role="status"
                    >
                        {view.message}
                    </p>
                ) : null}

                {view.kind === "ready" ? (
                    <>
                        <p className="mt-1 mb-4 text-xs text-muted-foreground">
                            A screen is asking to sign in to Flatline.
                        </p>
                        <label className="mb-3 block">
                            <span className="mb-1 block text-xs text-muted-foreground">Name this screen</span>
                            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
                        </label>
                        <p className="mb-3 text-xs text-muted-foreground">
                            {view.info.userAgent || "Unknown browser"} · requested {describeAge(view.info.ageSeconds)}
                            <br />
                            Same access as you. Never expires. Revoke it any time in Agents.
                        </p>
                        {hostMismatch(view.info.publicUrl, window.location.origin) ? (
                            <p className="mb-3 rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">
                                You opened this page at a different address than the one this server publishes (
                                {view.info.publicUrl}). If the screen cannot reach that address, check it before
                                approving.
                            </p>
                        ) : null}
                        <Button className="w-full" disabled={busy || name.trim() === ""} onClick={() => answer(true)}>
                            Approve
                        </Button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => answer(false)}
                            className="mt-3 block w-full cursor-pointer border-0 bg-transparent p-0 text-center text-xs text-muted-foreground underline"
                        >
                            Deny
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    );
}
