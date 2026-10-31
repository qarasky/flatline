"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isApiError } from "@/lib/api";
import { approveDeviceRequest, denyDeviceRequest, lookupDeviceRequest, type DeviceRequestInfo } from "@/lib/device-api";
import { codeFromHash, hostMismatch, isSignedOut } from "@/lib/device-auth";
import { SIGN_IN_PATH } from "@/lib/session";

type View =
    | { kind: "loading" }
    | { kind: "ready"; info: DeviceRequestInfo }
    | { kind: "done"; message: string }
    | { kind: "failed"; message: string };

function describeAge(seconds: number): string {
    return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)} min ago`;
}

function failure(e: unknown): string {
    if (isApiError(e, 404) || isApiError(e, 409)) {
        return "This request has expired or was already answered. Ask the screen to show a new QR code.";
    }
    return e instanceof Error ? e.message : "Could not reach the Flatline server.";
}

/** Signed out: sign in, then come back here with the code (it lives in the fragment, which never reaches the server). */
function signInAndReturn(code: string | null): void {
    const back = code ? `/device#${code}` : "/device";
    window.location.assign(`${SIGN_IN_PATH}?next=${encodeURIComponent(back)}`);
}

/**
 * The page a phone opens after scanning a screen's QR code (ported from the
 * old dashboard). It names the screen and approves or denies it; the screen
 * then signs itself in with its own operator token.
 */
export function DeviceApprove() {
    const [code, setCode] = useState<string | null | undefined>(undefined);
    const [view, setView] = useState<View>({ kind: "loading" });
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    // The fragment is the browser's: read it after mount.
    useEffect(() => setCode(codeFromHash(window.location.hash)), []);

    useEffect(() => {
        if (code === undefined) {
            return;
        }
        if (!code) {
            setView({
                kind: "failed",
                message: "This link has no request code. Scan the QR code on the screen again.",
            });
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
                if (cancelled) {
                    return;
                }
                if (isSignedOut(e)) {
                    signInAndReturn(code);
                    return;
                }
                setView({ kind: "failed", message: failure(e) });
            });
        return () => {
            cancelled = true;
        };
    }, [code]);

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
            if (isSignedOut(e)) {
                signInAndReturn(code);
            } else {
                setView({ kind: "failed", message: failure(e) });
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex min-h-svh items-center justify-center p-6">
            <div className="bg-card w-full max-w-sm rounded-lg border p-6">
                <h1 className="text-base font-semibold">Approve this screen?</h1>
                {view.kind === "loading" ? <p className="text-muted-foreground mt-3">Loading…</p> : null}
                {view.kind === "done" || view.kind === "failed" ? (
                    <p className={`mt-3 ${view.kind === "failed" ? "text-status-down" : ""}`} role="status">
                        {view.message}
                    </p>
                ) : null}
                {view.kind === "ready" ? (
                    <>
                        <p className="text-muted-foreground mt-1 mb-4 text-xs">
                            A screen is asking to sign in to Flatline.
                        </p>
                        <label className="mb-3 block">
                            <span className="text-muted-foreground mb-1 block text-xs">Name this screen</span>
                            <Input
                                id="device-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                maxLength={60}
                            />
                        </label>
                        <p className="text-muted-foreground mb-3 text-xs">
                            {view.info.userAgent || "Unknown browser"} · requested {describeAge(view.info.ageSeconds)}
                            <br />
                            Same access as you. Never expires. Revoke it any time in Tokens.
                        </p>
                        {hostMismatch(view.info.publicUrl, window.location.origin) ? (
                            <p className="bg-status-down/10 text-status-down mb-3 rounded-md px-2.5 py-2 text-xs">
                                You opened this page at a different address than the one this server publishes (
                                {view.info.publicUrl}). If the screen cannot reach that address, check it before
                                approving.
                            </p>
                        ) : null}
                        <Button
                            className="w-full"
                            disabled={busy || name.trim() === ""}
                            onClick={() => void answer(true)}
                        >
                            Approve
                        </Button>
                        <Button
                            variant="ghost"
                            className="mt-2 w-full"
                            disabled={busy}
                            onClick={() => void answer(false)}
                        >
                            Deny
                        </Button>
                    </>
                ) : null}
            </div>
        </div>
    );
}
