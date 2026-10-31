/**
 * New-deploy detection for the Next build.
 *
 * Each production build bakes its id into the client bundle
 * (`NEXT_PUBLIC_FLATLINE_BUILD`, set in next.config.ts). `GET /build` answers
 * the id of the build the server is running, so a tab still running the
 * previous bundle sees a different answer after a deploy. The dev server has
 * no id, and the watch does nothing there.
 */

/** This bundle's build id; null in development. */
export const BUILD_ID: string | null = process.env.NEXT_PUBLIC_FLATLINE_BUILD || null;

/** A different build is being served: only when both ids are known and differ. */
export function isNewBuild(loaded: string | null, served: string | null): boolean {
    return loaded !== null && served !== null && loaded !== served;
}

/** The id of the build the server is running now, or null when it cannot be read. */
export async function fetchServedBuild(signal?: AbortSignal): Promise<string | null> {
    try {
        const response = await fetch(`/build?check=${Date.now()}`, { cache: "no-store", signal });
        if (!response.ok) {
            return null;
        }
        const body: unknown = await response.json();
        return body && typeof body === "object" && "build" in body && typeof body.build === "string"
            ? body.build
            : null;
    } catch {
        return null;
    }
}

export interface VersionWatchOptions {
    /** Called once, when a different build is detected. */
    onNewVersion: () => void;
    /** Regular check cadence. */
    intervalMs?: number;
    /** Minimum gap between checks triggered by events (resync, focus). */
    minGapMs?: number;
    /** Subscribe to "the live stream just reconnected"; returns unsubscribe. */
    onResync?: (listener: () => void) => () => void;
    /** Overridable for tests. */
    loaded?: string | null;
    fetchServed?: (signal?: AbortSignal) => Promise<string | null>;
}

/**
 * Check for a new build every few minutes, when the tab becomes visible and
 * whenever the live stream reconnects (a deploy restarts it). Returns stop.
 */
export function startVersionWatch(options: VersionWatchOptions): () => void {
    const loaded = options.loaded !== undefined ? options.loaded : BUILD_ID;
    const fetchServed = options.fetchServed ?? fetchServedBuild;
    const intervalMs = options.intervalMs ?? 5 * 60_000;
    const minGapMs = options.minGapMs ?? 30_000;
    if (!loaded) {
        return () => {};
    }

    let stopped = false;
    let inFlight = false;
    let lastCheck = 0;

    async function check(force: boolean) {
        if (stopped || inFlight || (!force && Date.now() - lastCheck < minGapMs)) {
            return;
        }
        inFlight = true;
        lastCheck = Date.now();
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 15_000);
        try {
            const served = await fetchServed(controller.signal);
            if (!stopped && isNewBuild(loaded, served)) {
                stop();
                options.onNewVersion();
            }
        } finally {
            clearTimeout(deadline);
            inFlight = false;
        }
    }

    const timer = setInterval(() => void check(true), intervalMs);
    const onVisible = () => {
        if (typeof document !== "undefined" && !document.hidden) {
            void check(false);
        }
    };
    if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisible);
    }
    const unsubscribe = options.onResync?.(() => void check(false));
    void check(true);

    function stop() {
        stopped = true;
        clearInterval(timer);
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisible);
        }
        unsubscribe?.();
    }
    return stop;
}
