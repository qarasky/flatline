import type { Heartbeat, Incident, PasswordRequired, StatusPageData } from "./types";

/**
 * Client for the public status page API.
 *
 * Important: every read endpoint is password gated (see
 * server/status-page-auth.js), so this client never assumes it will get
 * data. It forwards the caller's cookie on the server side, and surfaces
 * `password_required` so the UI can show an unlock form instead of an empty
 * page.
 */

/** Thrown when a page exists but is locked behind a password. */
export class PasswordRequiredError extends Error {
    constructor() {
        super("This status page is password protected.");
        this.name = "PasswordRequiredError";
    }
}

/** Thrown when the slug does not resolve to a page. */
export class NotFoundError extends Error {
    constructor(slug: string) {
        super(`No status page for "${slug}".`);
        this.name = "NotFoundError";
    }
}

/**
 * A status page and its live heartbeat data.
 */
export interface IncidentHistoryPage {
    ok: boolean;
    incidents: Incident[];
    total: number;
    nextCursor: string | null;
    hasMore: boolean;
}

export interface StatusPageSnapshot {
    data: StatusPageData;
    /** Beats keyed by monitor id, newest first. */
    heartbeats: Record<string, Heartbeat[]>;
    /**
     * Resolved incidents. The config endpoint only returns pinned *active*
     * incidents, so history has to be fetched separately.
     */
    history: Incident[];
}

export interface FetchOptions {
    /**
     * Cookie header from the incoming request. Forwarded so the unlock cookie
     * set by the Flatline server is seen here.
     */
    cookie?: string | null;
    /** Abort long-lived fetches when a render is cancelled. */
    signal?: AbortSignal;
}

function joinUrl(base: string, path: string): string {
    return `${base.replace(/\/$/, "")}${path}`;
}

async function readJson<T>(url: string, options: FetchOptions): Promise<T> {
    const response = await fetch(url, {
        headers: {
            Accept: "application/json",
            ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
        cache: "no-store",
        // Server-side rendering forwards the cookie header explicitly; a
        // browser cannot set Cookie, so same-origin requests send the unlock
        // cookie via credentials instead. Node ignores the option.
        credentials: options.cookie ? "omit" : "include",
        signal: options.signal,
    });

    if (response.status === 404) {
        throw new NotFoundError(url);
    }

    if (response.status === 401) {
        throw new PasswordRequiredError();
    }

    if (!response.ok) {
        throw new Error(`Status page request failed: ${response.status}`);
    }

    return await response.json() as T;
}

/**
 * Fetch a status page with its live heartbeat data.
 *
 * Heartbeats are requested alongside the page rather than after it, so the two
 * are rendered in one pass instead of flashing an empty page.
 * @param baseUrl Origin of the Flatline server, e.g. "http://localhost:3001"
 * @param slug Status page slug
 * @param options Cookie forwarding and abort signal
 * @returns The page plus its live beats
 */
export async function fetchStatusPage(
    baseUrl: string,
    slug: string,
    options: FetchOptions = {}
): Promise<StatusPageSnapshot> {
    const encoded = encodeURIComponent(slug.toLowerCase());

    // An empty page must still render, so a failing history fetch degrades to
    // "no recent incidents" rather than a 500.
    const fallbackHistory: IncidentHistoryPage = { ok: true, incidents: [], total: 0, nextCursor: null, hasMore: false };

    const [data, heartbeat, history] = await Promise.all([
        readJson<StatusPageData>(joinUrl(baseUrl, `/api/status-page/${encoded}`), options),
        readJson<{ ok: boolean; heartbeatList: Record<string, Heartbeat[]> }>(
            joinUrl(baseUrl, `/api/status-page/heartbeat/${encoded}`),
            options
        ).catch(() => ({ ok: false, heartbeatList: {} })),
        readJson<IncidentHistoryPage>(
            joinUrl(baseUrl, `/api/status-page/${encoded}/incident-history`),
            options
        ).catch(() => fallbackHistory),
    ]);

    return {
        data,
        heartbeats: heartbeat.heartbeatList ?? {},
        history: history.incidents ?? [],
    };
}

/**
 * Whether a response body is the password-required marker.
 *
 * Used by the page component to distinguish "locked" from "broken".
 * @param body Parsed response body
 * @returns True when the page needs a password
 */
export function isPasswordRequired(body: unknown): body is PasswordRequired {
    return (
        typeof body === "object" &&
        body !== null &&
        (body as { error?: string }).error === "password_required"
    );
}
