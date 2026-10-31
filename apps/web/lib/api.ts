/**
 * Client for the Flatline API, usable from server and client components.
 *
 * - On the server it calls `API_URL` directly and forwards the session cookie,
 *   so server-rendered pages fetch as the signed-in person.
 * - In the browser it calls the same-origin `/api/...` path and lets the
 *   cookie ride along; writes add the CSRF header the backend requires.
 *
 * Non-2xx answers throw an {@link ApiError} carrying the API's error code,
 * message and hint.
 */

import { CSRF_HEADER, HOME_PATH, PASSWORD_PATH, PATH_HEADER, SESSION_COOKIE, SIGN_IN_PATH } from "@/lib/session";

export const DEFAULT_API_URL = "http://127.0.0.1:3001";

/** Server-side calls give up after this long and report the API unreachable. */
export const API_TIMEOUT_MS = 10_000;

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly hint?: string;

    constructor(status: number, code: string, message: string, hint?: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.hint = hint;
    }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
    return error instanceof ApiError && (status === undefined || error.status === status);
}

export interface RequestOptions {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
}

/** The fetch options for one call: headers, credentials and body. */
export function requestInit(opts: { server: boolean; session?: string; method?: string; body?: unknown }): RequestInit {
    const method = (opts.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method, headers, cache: "no-store" };

    if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
    }

    if (opts.server) {
        if (opts.session) {
            headers.Cookie = `${SESSION_COOKIE}=${opts.session}`;
        }
    } else {
        init.credentials = "same-origin";
    }
    // Both sides authenticate with the cookie, so both mark writes for CSRF.
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        headers[CSRF_HEADER] = "1";
    }
    return init;
}

function isServer(): boolean {
    return typeof window === "undefined";
}

export function apiBase(): string {
    return (process.env.API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

async function sessionId(): Promise<string | undefined> {
    // Imported lazily so this module stays usable from client components.
    const { cookies } = await import("next/headers");
    return (await cookies()).get(SESSION_COOKIE)?.value;
}

/**
 * A server-rendered page whose session the API rejected (signed out, removed,
 * reset or a revoked token) goes to sign-in, marked `expired` so the gate does not bounce it back.
 * Doing it here covers every server fetch, not only the layout's check, which
 * Next does not re-run when moving between pages.
 */
async function toSignIn(): Promise<void> {
    const [{ headers }, { redirect }] = await Promise.all([import("next/headers"), import("next/navigation")]);
    const path = (await headers()).get(PATH_HEADER) ?? HOME_PATH;
    // Throws Next's redirect signal; nothing after this runs.
    redirect(`${SIGN_IN_PATH}?expired=1&next=${encodeURIComponent(path)}`);
}

async function toError(response: Response): Promise<ApiError> {
    try {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            const record = body as { error: string; message?: unknown; hint?: unknown };
            return new ApiError(
                response.status,
                record.error,
                typeof record.message === "string" ? record.message : record.error,
                typeof record.hint === "string" ? record.hint : undefined
            );
        }
    } catch {
        // Not JSON (a proxy error page); fall through.
    }
    return new ApiError(response.status, `http_${response.status}`, `The server answered ${response.status}.`);
}

/** Call the API and decode its JSON answer. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/api/")) {
        throw new TypeError(`api(): path must start with /api/, got ${JSON.stringify(path)}`);
    }
    const server = isServer();
    const init = requestInit({
        server,
        session: server ? await sessionId() : undefined,
        method: options.method,
        body: options.body,
    });
    init.signal = options.signal ?? (server ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined);

    let response: Response;
    try {
        response = await fetch(server ? `${apiBase()}${path}` : path, init);
    } catch (error) {
        if (options.signal?.aborted) {
            throw error;
        }
        throw new ApiError(503, "unreachable", "Could not reach Flatline.");
    }
    if (!response.ok) {
        if (server && response.status === 401) {
            await toSignIn();
        }
        const error = await toError(response);
        if (server && error.code === "password_change_required") {
            // A starting password: nothing else works until it is changed.
            const { redirect } = await import("next/navigation");
            redirect(PASSWORD_PATH);
        }
        throw error;
    }
    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
}
