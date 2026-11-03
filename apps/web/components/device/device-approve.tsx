"use client";

import { useEffect, useState } from "react";

import { AuthScreen, Button, Field, Input } from "@qarasky/kore-ui";

import { isApiError } from "@/lib/api";
import {
    approveDeviceRequest,
    deviceSignInHref,
    denyDeviceRequest,
    lookupDeviceRequest,
    type DeviceRequestInfo,
} from "@/lib/device-api";
import { codeFromHash, hostMismatch, isSignedOut } from "@/lib/device-auth";
import { KORE_APP, KORE_NAMES } from "@/lib/kore";

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
    return e instanceof Error ? e.message : "Couldn't reach the Flatline server. Check your connection and try again.";
}

/** Signed out: sign in, then come back here with the code. */
function signInAndReturn(code: string | null): void {
    window.location.assign(deviceSignInHref(code));
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
        <AuthScreen
            app={KORE_APP}
            names={KORE_NAMES}
            title="Approve this screen?"
            description={view.kind === "ready" ? "A screen is asking to sign in to Flatline." : undefined}
            error={view.kind === "failed" ? view.message : null}
        >
            {view.kind === "loading" ? <p className="text-muted">Loading…</p> : null}
            {view.kind === "done" ? <p role="status">{view.message}</p> : null}
            {view.kind === "ready" ? (
                <>
                    <Field id="device-name" label="Name this screen">
                        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
                    </Field>
                    <p className="text-meta text-muted">
                        {view.info.userAgent || "Unknown browser"} · requested {describeAge(view.info.ageSeconds)}
                        <br />
                        Same access as you. Never expires. Revoke it any time in Tokens.
                    </p>
                    {hostMismatch(view.info.publicUrl, window.location.origin) ? (
                        <p className="text-meta bg-warning/10 text-warning rounded-ui px-3 py-2">
                            You opened this page at a different address than the one this server publishes (
                            {view.info.publicUrl}). If the screen can&apos;t reach that address, check it before
                            approving.
                        </p>
                    ) : null}
                    <div className="flex flex-col gap-2">
                        <Button
                            variant="primary"
                            fullWidth
                            loading={busy}
                            disabled={name.trim() === ""}
                            onClick={() => void answer(true)}
                        >
                            Approve
                        </Button>
                        <Button variant="ghost" fullWidth disabled={busy} onClick={() => void answer(false)}>
                            Deny
                        </Button>
                    </div>
                </>
            ) : null}
        </AuthScreen>
    );
}
