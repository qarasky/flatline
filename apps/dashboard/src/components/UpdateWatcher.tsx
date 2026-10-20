import { useEffect, useRef, useState } from "react";
import { startVersionWatch } from "@/lib/build-version";
import { onLiveResync } from "@/lib/live-hub";

/** How often an unattended screen re-checks before reloading over a focused field. */
const RELOAD_RETRY_MS = 10_000;

function typing(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable));
}

/**
 * Watches for a new deploy (see lib/build-version.ts).
 *
 * `reload`: unattended screens (the kiosk wall, public status pages) reload
 * themselves — unless someone is typing (the status-page unlock form), in
 * which case they wait. `prompt`: operator routes get a small banner, since
 * reloading under an operator could drop an open form.
 *
 * Mounted once at the root; the mode follows the current route.
 */
export function UpdateWatcher({ mode }: { mode: "reload" | "prompt" }) {
    const [available, setAvailable] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const modeRef = useRef(mode);
    modeRef.current = mode;

    useEffect(() => startVersionWatch({ onNewVersion: () => setAvailable(true), onResync: onLiveResync }), []);

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
            className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg"
            role="status"
        >
            <span>A new version of Flatline is available.</span>
            <button
                type="button"
                className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground"
                onClick={() => window.location.reload()}
            >
                Reload
            </button>
            <button type="button" className="text-quiet hover:text-foreground" onClick={() => setDismissed(true)}>
                Later
            </button>
        </div>
    );
}
