import { useEffect, useMemo, useRef, useState } from "react";
import { pollDeviceSignIn, setToken, startDeviceSignIn } from "@/lib/api";
import { qrSvg } from "@/lib/device-auth";
import { runDeviceSignIn, type DeviceSignInStatus } from "@/lib/device-poll";

function formatRemaining(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Sign this screen in by scanning a QR code with a phone that is already
 * signed in. The code is requested on mount and renewed whenever it expires;
 * once the phone approves, the screen stores its own token exactly like the
 * paste flow does. Nothing is typed on this screen.
 */
export function DeviceSignIn({ onSaved }: { onSaved: () => void }) {
    const [code, setCode] = useState<{ url: string; expiresAt: number } | null>(null);
    const [status, setStatus] = useState<DeviceSignInStatus>("waiting");
    const [now, setNow] = useState(() => Date.now());
    // Parents pass an inline callback; keeping it in a ref stops a re-render
    // from restarting the request (and swapping the QR code under the user).
    const saved = useRef(onSaved);
    saved.current = onSaved;

    useEffect(() => {
        const controller = new AbortController();
        const timer = window.setInterval(() => setNow(Date.now()), 1000);

        void runDeviceSignIn({
            origin: window.location.origin,
            signal: controller.signal,
            now: Date.now,
            start: startDeviceSignIn,
            poll: (requestCode, secret) => pollDeviceSignIn(requestCode, secret, controller.signal),
            wait: (ms) =>
                new Promise<void>((resolve) => {
                    const done = window.setTimeout(resolve, ms);
                    controller.signal.addEventListener(
                        "abort",
                        () => {
                            window.clearTimeout(done);
                            resolve();
                        },
                        { once: true }
                    );
                }),
            onCode: setCode,
            onStatus: setStatus,
        }).then((token) => {
            if (token) {
                setToken(token);
                saved.current();
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
        <div className="text-center">
            <div className="mx-auto mb-3 flex size-44 items-center justify-center rounded-md bg-white">
                {image ? <img src={image} alt="QR code to sign this screen in" className="size-full" /> : null}
            </div>
            <p className="m-0 text-sm">Scan with your phone, where you're already signed in</p>
            <p className="mt-1 mb-0 text-xs text-muted-foreground" role="status">
                {status === "denied"
                    ? "Request denied. Showing a new code…"
                    : status === "error"
                      ? "Can't reach the server. Retrying…"
                      : code
                        ? `Waiting for approval… code expires in ${formatRemaining(code.expiresAt - now)}`
                        : "Preparing a code…"}
            </p>
        </div>
    );
}
