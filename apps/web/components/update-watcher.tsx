"use client";

import { useEffect, useRef, useState } from "react";

import { startVersionWatch } from "@/lib/build-id";

/** How often an unattended screen re-checks before reloading over a focused field. */
const RELOAD_RETRY_MS = 10_000;

function typing(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable));
}

/**
 * Watches for a new deploy (lib/build-id.ts), ported from the old dashboard.
 * `reload`: unattended screens (the kiosk wall, status pages) reload
 * themselves, waiting while someone types. `prompt`: operator pages get a
 * small "new version" bar, since a reload could drop an open form.
 */
export function UpdateWatcher({
    mode,
    onResync,
}: {
    mode: "reload" | "prompt";
    /** Also check when the live stream reconnects (pages that have one). */
    onResync?: (listener: () => void) => () => void;
}) {
    const [available, setAvailable] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const modeRef = useRef(mode);
    modeRef.current = mode;

    useEffect(() => startVersionWatch({ onNewVersion: () => setAvailable(true), onResync }), [onResync]);

    useEffect(() => {
        if (!available || mode !== "reload") {
            return;
        }
        const attempt = () => {
            if (modeRef.current === "reload" && !typing()) {
                window.location.reload();
                return true;
            }
            return false;
        };
        if (attempt()) {
            return;
        }
        const timer = window.setInterval(attempt, RELOAD_RETRY_MS);
        return () => window.clearInterval(timer);
    }, [available, mode]);

    if (!available || mode !== "prompt" || dismissed) {
        return null;
    }
    return (
        <div
            className="bg-card fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-md border px-4 py-3 shadow-lg"
            role="status"
        >
            <span>A new version of Flatline is available.</span>
            <button
                type="button"
                className="bg-primary text-primary-foreground rounded-md px-3 py-1 font-medium"
                onClick={() => window.location.reload()}
            >
                Reload
            </button>
            <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setDismissed(true)}
            >
                Later
            </button>
        </div>
    );
}
