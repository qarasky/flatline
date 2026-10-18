import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStatusPage, NotFoundError, PasswordRequiredError, type StatusPageSnapshot } from "@flatline/shared";
import { StatusPageView } from "@/components/status/StatusPageView";
import { UnlockForm } from "@/components/status/UnlockForm";

/**
 * Public status page app: resolves a slug (from the path, or from the
 * request host for client domains), fetches the password-gated data, and
 * renders the view. No operator token is involved — this route is public by
 * design, and the API decides what it may see.
 *
 * Refresh: the page re-fetches every 30 seconds while visible, so a wall
 * screen showing a client status page stays current without a reload (the
 * standalone Next.js app re-rendered per request only).
 */

const REFRESH_MS = 30_000;

type Phase =
    | { phase: "loading" }
    | { phase: "page"; slug: string; snapshot: StatusPageSnapshot }
    | { phase: "locked"; slug: string }
    | { phase: "notfound" }
    | { phase: "error"; message: string };

/**
 * Resolve the request hostname to a status page slug via the Flatline API.
 * The domain map lives only on the server; the browser asks it rather than
 * keeping a second copy. Returns the slug only, never page content.
 * @returns Slug, or null when this host is not mapped
 */
async function slugFromHost(): Promise<string | null> {
    const host = window.location.hostname.toLowerCase();
    if (!host) {
        return null;
    }
    try {
        const response = await fetch(`/api/status-page/resolve-host?host=${encodeURIComponent(host)}`, {
            cache: "no-store",
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as { slug?: string | null };
        return typeof body.slug === "string" && body.slug !== "" ? body.slug : null;
    } catch {
        return null;
    }
}

/**
 * @param props.slug Slug from the path, or null to resolve from the host
 * @param props.fallback Rendered when the host maps to no page (the private
 * dashboard, for the site root)
 */
export function StatusPageApp({ slug, fallback }: { slug: string | null; fallback?: React.ReactNode }) {
    const [state, setState] = useState<Phase>({ phase: "loading" });
    // Which slug we are actually showing, after host resolution.
    const [resolved, setResolved] = useState<string | null>(slug);
    const [unmapped, setUnmapped] = useState(false);
    const requestRef = useRef(0);

    const load = useCallback(async (target: string) => {
        const request = ++requestRef.current;
        try {
            // Empty base: same origin as the app that serves this page.
            const snapshot = await fetchStatusPage("", target);
            if (request !== requestRef.current) {
                return;
            }
            setState({ phase: "page", slug: target, snapshot });
            document.title = snapshot.data.config.title || "Status";
        } catch (error) {
            if (request !== requestRef.current) {
                return;
            }
            if (error instanceof PasswordRequiredError) {
                setState({ phase: "locked", slug: target });
            } else if (error instanceof NotFoundError) {
                setState({ phase: "notfound" });
            } else {
                setState({
                    phase: "error",
                    message: error instanceof Error ? error.message : "Could not load the status page.",
                });
            }
        }
    }, []);

    // Resolve the target once per slug prop.
    useEffect(() => {
        let alive = true;
        if (slug) {
            setResolved(slug);
            setUnmapped(false);
            return;
        }
        slugFromHost().then((found) => {
            if (!alive) {
                return;
            }
            setResolved(found);
            setUnmapped(found === null);
        });
        return () => {
            alive = false;
        };
    }, [slug]);

    // Fetch on target change, then keep refreshing while the tab is visible.
    useEffect(() => {
        if (!resolved) {
            return;
        }
        void load(resolved);
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                void load(resolved);
            }
        }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [resolved, load]);

    if (unmapped) {
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

    if (state.phase === "loading" || (!resolved && !unmapped)) {
        return (
            <div className="status-page">
                <div className="wrap">
                    <p className="site-description" role="status">
                        Loading status…
                    </p>
                </div>
            </div>
        );
    }

    if (state.phase === "notfound") {
        return (
            <div className="status-page">
                <div className="wrap">
                    <p className="site-description">No status page found.</p>
                </div>
            </div>
        );
    }

    if (state.phase === "error") {
        return (
            <div className="status-page">
                <div className="wrap">
                    <p className="site-description" role="alert">
                        {state.message}
                    </p>
                </div>
            </div>
        );
    }

    if (state.phase === "locked") {
        return <UnlockForm slug={state.slug} onUnlocked={() => void load(state.slug)} />;
    }

    if (state.phase === "page") {
        return (
            <StatusPageView
                data={state.snapshot.data}
                heartbeats={state.snapshot.heartbeats}
                history={state.snapshot.history}
            />
        );
    }

    return null;
}
