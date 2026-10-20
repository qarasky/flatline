/**
 * New-deploy detection without backend support.
 *
 * Vite names the entry chunk after its content hash (`/assets/index-<hash>.js`)
 * and the backend serves `index.html` uncached, so a tab can tell that a new
 * build is live by fetching `index.html` and comparing the entry script it
 * references with the one this tab is running. Kiosk walls otherwise keep
 * the old bundle until someone reloads them by hand.
 *
 * The fingerprint is the entry script plus the first stylesheet: a change in
 * any lazy chunk changes the entry's hash (it imports them by hashed name),
 * but a CSS-only change does not, so the main stylesheet is compared too.
 * Only the first stylesheet counts because Vite appends lazy chunks' styles
 * to the live document at runtime.
 */

/** Normalise an asset URL to its path, dropping origin, query and hash. */
function assetPath(src: string, extension: "js" | "css" = "js"): string | null {
    try {
        const path = new URL(src, "http://localhost").pathname;
        return new RegExp(`/assets/[^/]+\\.${extension}$`).test(path) ? path : null;
    } catch {
        return null;
    }
}

/** The first hashed stylesheet among `<link>` tags in document order. */
function firstStylesheet(tags: string[]): string | null {
    for (const tag of tags) {
        if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(tag)) {
            continue;
        }
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const path = href ? assetPath(href, "css") : null;
        if (path) {
            return path;
        }
    }
    return null;
}

function fingerprint(entry: string | null, stylesheet: string | null): string | null {
    return entry ? `${entry}|${stylesheet ?? ""}` : null;
}

/**
 * Build fingerprint of an `index.html`: entry script plus main stylesheet.
 * @returns Null when there is no hashed entry (dev server, an error page)
 */
export function buildFingerprintFromHtml(html: string): string | null {
    return fingerprint(entryAssetFromHtml(html), firstStylesheet(html.match(/<link\b[^>]*>/gi) ?? []));
}

/**
 * Build fingerprint of the document this tab is running.
 * @returns Null in development
 */
export function loadedBuildFingerprint(doc: Pick<Document, "querySelectorAll"> = document): string | null {
    const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')).map(
        (link) => `<link rel="stylesheet" href="${link.getAttribute("href") ?? ""}">`
    );
    return fingerprint(loadedEntryAsset(doc), firstStylesheet(links));
}

/**
 * The hashed entry script referenced by an `index.html`.
 * @param html Document source
 * @returns Path such as "/assets/index-tGS1SSt4.js", or null when there is
 * none (the dev server, an error page)
 */
export function entryAssetFromHtml(html: string): string | null {
    const tags = html.match(/<script\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
        if (!/\btype\s*=\s*["']?module["']?/i.test(tag)) {
            continue;
        }
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const path = src ? assetPath(src) : null;
        if (path) {
            return path;
        }
    }
    return null;
}

/**
 * The hashed entry script this tab was loaded with.
 * @param doc Document to inspect
 * @returns Its path, or null in development (unhashed /src/main.tsx)
 */
export function loadedEntryAsset(doc: Pick<Document, "querySelectorAll"> = document): string | null {
    for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
        const path = assetPath(script.getAttribute("src") ?? "");
        if (path) {
            return path;
        }
    }
    return null;
}

/**
 * Whether the served build differs from the loaded one. Unknown on either
 * side (dev server, failed fetch, an error page) is never "new".
 */
export function isNewBuild(loaded: string | null, served: string | null): boolean {
    return loaded !== null && served !== null && loaded !== served;
}

/**
 * Fetch `index.html` past every cache and fingerprint it.
 * @param signal Deadline
 * @returns The served fingerprint, or null when it cannot be determined
 */
export async function fetchServedFingerprint(signal?: AbortSignal): Promise<string | null> {
    try {
        const response = await fetch(`/index.html?build-check=${Date.now()}`, {
            cache: "no-store",
            headers: { Accept: "text/html" },
            signal,
        });
        if (!response.ok) {
            return null;
        }
        return buildFingerprintFromHtml(await response.text());
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
 * Check for a new build every few minutes, when the tab becomes visible, and
 * whenever the live stream reconnects (a deploy restarts the backend, so a
 * reconnect is the moment a new build is most likely).
 * @returns Stop watching
 */
export function startVersionWatch(options: VersionWatchOptions): () => void {
    const loaded = options.loaded !== undefined ? options.loaded : loadedBuildFingerprint();
    const fetchServed = options.fetchServed ?? fetchServedFingerprint;
    const intervalMs = options.intervalMs ?? 5 * 60_000;
    const minGapMs = options.minGapMs ?? 30_000;
    if (!loaded) {
        // Development server or an unexpected document: nothing to compare.
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
        if (!document.hidden) {
            void check(false);
        }
    };
    document.addEventListener("visibilitychange", onVisible);
    const stopResync = options.onResync?.(() => void check(false)) ?? (() => {});

    function stop() {
        stopped = true;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
        stopResync();
    }
    return stop;
}
