"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthScreen, Spinner } from "@qarasky/kore-ui";

import { api } from "@/lib/api";
import { pollDeviceSignIn, startDeviceSignIn } from "@/lib/device-api";
import { qrSvg } from "@/lib/device-auth";
import { exchangeTokenForSession } from "@/lib/kiosk-exchange";
import { createSession, keepMigrating } from "@/lib/legacy-token";
import { abortableWait, runDeviceSignIn, type DeviceSignInStatus } from "@/lib/device-poll";
import { KORE_APP, KORE_NAMES } from "@/lib/kore";

function formatRemaining(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Sign a wall screen in by scanning a QR code with a phone that is already
 * signed in (ported from the old dashboard's DeviceSignIn). The code is
 * requested on mount and renewed when it expires. Once the phone approves,
 * the screen trades its new token for a session cookie and reloads; the
 * token itself is never stored. Nothing is typed on this screen.
 *
 * A screen that ran the old dashboard first trades the token that one left
 * in localStorage for a session (retrying while Flatline is unreachable,
 * as it is right after a deploy); only without one does it show a QR.
 */
export function KioskSignIn() {
    const [code, setCode] = useState<{ url: string; expiresAt: number } | null>(null);
    const [status, setStatus] = useState<DeviceSignInStatus>("waiting");
    const [now, setNow] = useState(() => Date.now());
    const [failed, setFailed] = useState(false);
    const [migrating, setMigrating] = useState(true);

    useEffect(() => {
        const controller = new AbortController();
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        void keepMigrating({
            storage: window.localStorage,
            createSession,
            wait: (ms) => abortableWait(ms, controller.signal),
            signal: controller.signal,
        })
            .then((migrated) => {
                if (controller.signal.aborted) {
                    return null;
                }
                if (migrated === "migrated") {
                    window.location.reload();
                    return null;
                }
                setMigrating(false);
                return runDeviceSignIn({
                    origin: window.location.origin,
                    signal: controller.signal,
                    now: Date.now,
                    start: startDeviceSignIn,
                    poll: (requestCode, secret) => pollDeviceSignIn(requestCode, secret, controller.signal),
                    wait: (ms) => abortableWait(ms, controller.signal),
                    onCode: setCode,
                    onStatus: setStatus,
                });
            })
            .then(async (token) => {
                if (!token) {
                    return;
                }
                const signedIn = await exchangeTokenForSession(
                    () => api("/api/v1/auth/session", { method: "POST", body: { token } }),
                    (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
                );
                if (signedIn) {
                    window.location.reload();
                    return;
                }
                // Start over with a fresh QR shortly; the unused screen token can be deleted in Tokens.
                setFailed(true);
                window.setTimeout(() => window.location.reload(), 30_000);
            });
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, []);

    const image = useMemo(
        () => (code ? `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg(code.url))}` : null),
        [code]
    );

    return (
        <AuthScreen app={KORE_APP} names={KORE_NAMES} title="Sign in" description="This screen signs in with a phone.">
            <div className="flex flex-col items-center gap-3 text-center">
                {/* The QR keeps a white quiet zone so any phone camera reads it. */}
                <div className="flex size-48 items-center justify-center rounded-ui bg-white p-2">
                    {image ? (
                        <img src={image} alt="QR code to sign this screen in" className="size-full" />
                    ) : (
                        <Spinner size={24} className="text-black/40" />
                    )}
                </div>
                <p>{migrating ? "Signing in…" : "Scan with your phone, where you\u2019re already signed in"}</p>
                <p className="text-meta text-muted" role="status">
                    {failed
                        ? "Approved, but this screen could not sign in. Showing a new code in 30 seconds…"
                        : status === "denied"
                          ? "Request denied. Showing a new code…"
                          : status === "error"
                            ? "Couldn't reach the server. Retrying…"
                            : code
                              ? `Waiting for approval… code expires in ${formatRemaining(code.expiresAt - now)}`
                              : "Preparing a code…"}
                </p>
            </div>
        </AuthScreen>
    );
}
