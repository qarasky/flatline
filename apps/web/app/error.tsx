"use client";

import { Button, EmptyState } from "@qarasky/kore-ui";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";

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
        <div role="alert" className="flex min-h-[60vh] flex-1 items-center justify-center">
            <EmptyState
                icon={<RefreshCw />}
                title="Couldn't load this page"
                description="Flatline may be restarting. Retrying on its own…"
                action={<Button onClick={retry}>Try again now</Button>}
            />
        </div>
    );
}
