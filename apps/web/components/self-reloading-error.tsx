"use client";

import { EmptyState } from "@qarasky/kore-ui";
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
        <div role="alert" className="bg-bg text-text flex min-h-svh items-center justify-center">
            <EmptyState title={`${what} couldn't be shown.`} description="Reloading in 30 seconds…" />
        </div>
    );
}
