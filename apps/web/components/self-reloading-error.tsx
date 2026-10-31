"use client";

import { useEffect } from "react";

/** How long an unattended screen shows an error before reloading itself. */
const RELOAD_AFTER_MS = 30_000;

/**
 * The error screen for pages nobody sits at (the kiosk, status pages): it
 * says what happened and reloads itself after 30 seconds, as the old
 * dashboard's route boundary did.
 */
export function SelfReloadingError({ what }: { what: string }) {
    useEffect(() => {
        const timer = window.setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
        return () => window.clearTimeout(timer);
    }, []);
    return (
        <div role="alert" className="flex min-h-svh flex-col items-center justify-center gap-2 p-10 text-center">
            <p className="font-medium">{what} could not be shown.</p>
            <p className="text-quiet text-sm">Reloading in 30 seconds…</p>
        </div>
    );
}
