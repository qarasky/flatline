import { useEffect, useRef, useState } from "react";
import { fetchStatusPage, NotFoundError, PasswordRequiredError, type StatusPageSnapshot } from "@flatline/shared";
import { StatusPageView } from "@/components/status/StatusPageView";
import { UnlockForm } from "@/components/status/UnlockForm";
import {
    nextPagePhase,
    parseResolveHost,
    retryDelayMs,
    shouldBackOff,
    type HostState,
    type LoadOutcome,
    type PagePhase,
} from "@/lib/status-snapshot";

/**
 * Public status page app: resolves a slug (from the path, or from the
 * request host for client domains), fetches the password-gated data, and
 * renders the view. No operator token is involved — this route is public by
 * design, and the API decides what it may see.
 *
 * Refresh: the page re-fetches every 30 seconds while visible, so a wall
 * screen showing a client status page stays current without a reload. A
 * failed refresh keeps the last good page on screen under a "stale" banner
 * and retries with backoff; see lib/status-snapshot.ts for the rules.
 */

const REFRESH_MS = 30_000;
/** One request's deadline; a hung fetch must not stop the refresh loop. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Resolve the request hostname to a status page slug via the Flatline API.
 * The domain map lives only on the server; the browser asks it rather than
 * keeping a second copy. Returns the slug only, never page content.
 * @returns Mapped slug, unmapped (only on a successful `{slug: null}`), or an
 * error to retry
 */
async function slugFromHost(signal: AbortSignal): Promise<HostState> {
    const host = window.location.hostname.toLowerCase();
    if (!host) {
        return { kind: "unmapped" };
    }
    try {
        const response = await fetch(`/api/status-page/resolve-host?host=${encodeURIComponent(host)}`, {
            cache: "no-store",
            signal,
        });
        const body: unknown = response.ok ? await response.json() : null;
        return parseResolveHost(response.ok, body);
    } catch {
        return { kind: "error", message: "Could not reach the status server." };
    }
}

/**
 * Load one snapshot and classify the result.
 * @param slug Page slug
 * @param previous Last good snapshot, kept for parts that fail to load
 * @param signal Deadline
 */
async function loadOnce(slug: string, previous: StatusPageSnapshot | null, signal: AbortSignal): Promise<LoadOutcome> {
    try {
        // Empty base: same origin as the app that serves this page.
        const snapshot = await fetchStatusPage("", slug, { signal, previous });
        return { kind: "ok", snapshot };
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

/** Abort controller that fires after `ms`; call `done()` once settled. */
function deadline(ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function formatClock(epoch: number): string {
    return new Date(epoch).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Notice({ children }: { children: React.ReactNode }) {
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
 * @param props.slug Slug from the path, or null to resolve from the host
 * @param props.fallback Rendered when the host maps to no page (the private
 * dashboard, for the site root)
 */
export function StatusPageApp({ slug, fallback }: { slug: string | null; fallback?: React.ReactNode }) {
    const [host, setHost] = useState<HostState>(() => (slug ? { kind: "mapped", slug } : { kind: "resolving" }));
    const [state, setState] = useState<PagePhase>({ phase: "loading" });
    // Bumped to refetch immediately (after unlocking).
    const [kick, setKick] = useState(0);
    const lastGood = useRef<StatusPageSnapshot | null>(null);

    // Resolve the target once per slug prop; retry errors with backoff.
    useEffect(() => {
        if (slug) {
            setHost({ kind: "mapped", slug });
            return;
        }
        setHost({ kind: "resolving" });
        let alive = true;
        let attempt = 0;
        let timer: number | undefined;
        let pending: { signal: AbortSignal; done: () => void } | null = null;

        const run = async () => {
            pending = deadline(REQUEST_TIMEOUT_MS);
            const outcome = await slugFromHost(pending.signal);
            pending.done();
            if (!alive) {
                return;
            }
            setHost(outcome);
            if (outcome.kind === "error") {
                timer = window.setTimeout(() => void run(), retryDelayMs(attempt++));
            }
        };
        void run();
        return () => {
            alive = false;
            pending?.done();
            window.clearTimeout(timer);
        };
    }, [slug]);

    const target = host.kind === "mapped" ? host.slug : null;

    // Fetch on target change, then keep refreshing while the tab is visible;
    // failures retry on a backoff instead of waiting a full interval.
    useEffect(() => {
        if (!target) {
            return;
        }
        let alive = true;
        let attempt = 0;
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
            const outcome = await loadOnce(target, lastGood.current, pending.signal);
            pending.done();
            if (!alive) {
                return;
            }
            if (outcome.kind === "ok") {
                lastGood.current = outcome.snapshot;
                document.title = outcome.snapshot.data.config.title || "Status";
            }
            setState((previous) => nextPagePhase(previous, outcome, target, Date.now()));
            if (outcome.kind === "locked") {
                // The unlock form refetches when it succeeds.
                return;
            }
            attempt = shouldBackOff(outcome) ? attempt + 1 : 0;
            schedule(attempt > 0 ? Math.min(REFRESH_MS, retryDelayMs(attempt - 1)) : REFRESH_MS);
        };
        void run();
        return () => {
            alive = false;
            pending?.done();
            window.clearTimeout(timer);
        };
    }, [target, kick]);

    if (host.kind === "unmapped") {
        return (
            fallback ?? (
                <div className="status-page">
                    <div className="wrap">
                        <h1 className="site-title">Status</h1>
                        <p className="site-description">This address is not mapped to a status page.</p>
                    </div>
                </div>
            )
        );
    }

    if (host.kind === "error") {
        // Never the fallback here: on a client's status domain that would be
        // the operator token gate.
        return <Notice>Could not reach the status server. Retrying…</Notice>;
    }

    if (host.kind === "resolving" || state.phase === "loading") {
        return <Notice>Loading status…</Notice>;
    }

    if (state.phase === "notfound") {
        return <Notice>No status page found.</Notice>;
    }

    if (state.phase === "error") {
        return <Notice>{state.message} Retrying…</Notice>;
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
