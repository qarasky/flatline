"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { retryDelayMs } from "@/lib/retry";

/**
 * Shown when an admin page could not be rendered, almost always because the
 * backend is down or still starting (power cuts, deploys). It retries on its
 * own with backoff, so an open tab recovers without anyone touching it.
 */
export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    const router = useRouter();
    const [attempt, setAttempt] = useState(0);

    const retry = () => {
        startTransition(() => {
            router.refresh();
            reset();
        });
    };

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setAttempt((n) => n + 1);
            retry();
        }, retryDelayMs(attempt));
        return () => window.clearTimeout(timer);
    }, [attempt]);

    return (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <p className="font-medium">Could not load this page.</p>
            <p className="text-muted-foreground">Flatline may be restarting. Retrying on its own…</p>
            <Button variant="secondary" onClick={retry}>
                Try again now
            </Button>
        </div>
    );
}
