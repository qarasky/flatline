"use client";

import { fetchStatusPage, NotFoundError, PasswordRequiredError, type StatusPageSnapshot } from "@flatline/shared";
import { useEffect, useRef, useState } from "react";

import { nextPagePhase, retryDelayMs, shouldBackOff, type LoadOutcome, type PagePhase } from "@/lib/status-snapshot";

import { StatusPageView } from "./status-page-view";
import { UnlockForm } from "./unlock-form";

/** Refresh cadence while the tab is visible. */
const REFRESH_MS = 30_000;
/** One request's deadline; a hung fetch must not stop the refresh loop. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Load one snapshot in the browser and classify it (the unlock cookie rides along same-origin). */
async function loadOnce(slug: string, previous: StatusPageSnapshot | null, signal: AbortSignal): Promise<LoadOutcome> {
    try {
        return { kind: "ok", snapshot: await fetchStatusPage("", slug, { signal, previous }) };
    } catch (error) {
        if (error instanceof PasswordRequiredError) {
            return { kind: "locked" };
        }
        if (error instanceof NotFoundError) {
            return { kind: "notfound" };
        }
        return {
            kind: "error",
            message: signal.aborted
                ? "The status server took too long to answer."
                : error instanceof Error
                  ? error.message
                  : "Could not load the status page.",
        };
    }
}

function deadline(ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function formatClock(epoch: number): string {
    return new Date(epoch).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function StatusNotice({ children }: { children: React.ReactNode }) {
    return (
        <div className="status-page">
            <div className="wrap">
                <p className="site-description" role="status">
                    {children}
                </p>
            </div>
        </div>
    );
}

/**
 * A public status page after its server render: it keeps itself current,
 * refreshing every 30 seconds while visible. A failed refresh keeps the last
 * good page under a "Stale since" banner and retries with backoff (the rules
 * are in lib/status-snapshot.ts, ported with their tests). Unlocking a
 * protected page refetches at once.
 * @param props.slug The page
 * @param props.initial What the server read
 * @param props.renderedAt When the server read it (epoch ms)
 */
export function StatusPageApp({
    slug,
    initial,
    renderedAt,
}: {
    slug: string;
    initial: LoadOutcome;
    renderedAt: number;
}) {
    const [state, setState] = useState<PagePhase>(() => nextPagePhase({ phase: "loading" }, initial, slug, renderedAt));
    const [kick, setKick] = useState(0);
    const lastGood = useRef<StatusPageSnapshot | null>(initial.kind === "ok" ? initial.snapshot : null);

    useEffect(() => {
        let alive = true;
        let attempt = initial.kind === "error" ? 1 : 0;
        let timer: number | undefined;
        let pending: { signal: AbortSignal; done: () => void } | null = null;

        const schedule = (ms: number) => {
            timer = window.setTimeout(() => {
                if (document.hidden) {
                    schedule(REFRESH_MS);
                } else {
                    void run();
                }
            }, ms);
        };
        const run = async () => {
            pending = deadline(REQUEST_TIMEOUT_MS);
            const outcome = await loadOnce(slug, lastGood.current, pending.signal);
            pending.done();
            if (!alive) {
                return;
            }
            if (outcome.kind === "ok") {
                lastGood.current = outcome.snapshot;
                document.title = outcome.snapshot.data.config.title || "Status";
            }
            setState((previous) => nextPagePhase(previous, outcome, slug, Date.now()));
            if (outcome.kind === "locked") {
                return;
            }
            attempt = shouldBackOff(outcome) ? attempt + 1 : 0;
            schedule(attempt > 0 ? Math.min(REFRESH_MS, retryDelayMs(attempt - 1)) : REFRESH_MS);
        };
        // The server already read the page: the first refresh waits its turn,
        // unless that read failed or this is a refetch after unlocking.
        if (kick > 0) {
            void run();
        } else {
            schedule(attempt > 0 ? retryDelayMs(0) : REFRESH_MS);
        }
        return () => {
            alive = false;
            pending?.done();
            window.clearTimeout(timer);
        };
        // `initial` seeds only the first render.
    }, [slug, kick]);

    if (state.phase === "loading") {
        return <StatusNotice>Loading status…</StatusNotice>;
    }
    if (state.phase === "notfound") {
        return <StatusNotice>No status page found.</StatusNotice>;
    }
    if (state.phase === "error") {
        return <StatusNotice>{state.message} Retrying…</StatusNotice>;
    }
    if (state.phase === "locked") {
        return <UnlockForm slug={state.slug} onUnlocked={() => setKick((k) => k + 1)} />;
    }
    return (
        <StatusPageView
            data={state.snapshot.data}
            heartbeats={state.snapshot.heartbeats}
            history={state.snapshot.history}
            notice={
                state.stale ? (
                    <div className="stale-banner" role="status">
                        Stale since {formatClock(state.updatedAt)} — the latest status could not be loaded. Retrying…
                    </div>
                ) : null
            }
        />
    );
}
