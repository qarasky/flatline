"use client";

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import { pollDeviceSignIn, startDeviceSignIn } from "@/lib/device-api";
import { qrSvg } from "@/lib/device-auth";
import { abortableWait, runDeviceSignIn, type DeviceSignInStatus } from "@/lib/device-poll";

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
 */
export function KioskSignIn() {
    const [code, setCode] = useState<{ url: string; expiresAt: number } | null>(null);
    const [status, setStatus] = useState<DeviceSignInStatus>("waiting");
    const [now, setNow] = useState(() => Date.now());
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        void runDeviceSignIn({
            origin: window.location.origin,
            signal: controller.signal,
            now: Date.now,
            start: startDeviceSignIn,
            poll: (requestCode, secret) => pollDeviceSignIn(requestCode, secret, controller.signal),
            wait: (ms) => abortableWait(ms, controller.signal),
            onCode: setCode,
            onStatus: setStatus,
        }).then(async (token) => {
            if (!token) {
                return;
            }
            try {
                await api("/api/v1/auth/session", { method: "POST", body: { token } });
                window.location.reload();
            } catch {
                setFailed(true);
            }
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
        <div className="flex min-h-svh items-center justify-center p-6">
            <div className="w-full max-w-sm text-center">
                <h1 className="mb-1 text-lg font-semibold">Sign in to Flatline</h1>
                <p className="mb-4 text-xs text-muted-foreground">This screen signs in with a phone.</p>
                <div className="mx-auto mb-3 flex size-44 items-center justify-center rounded-md bg-white">
                    {image ? <img src={image} alt="QR code to sign this screen in" className="size-full" /> : null}
                </div>
                <p className="m-0 text-sm">Scan with your phone, where you&apos;re already signed in</p>
                <p className="mt-1 mb-0 text-xs text-muted-foreground" role="status">
                    {failed
                        ? "Approved, but this screen could not sign in. Reload to try again."
                        : status === "denied"
                          ? "Request denied. Showing a new code…"
                          : status === "error"
                            ? "Can't reach the server. Retrying…"
                            : code
                              ? `Waiting for approval… code expires in ${formatRemaining(code.expiresAt - now)}`
                              : "Preparing a code…"}
                </p>
            </div>
        </div>
    );
}
