import "server-only";

import { fetchStatusPage, NotFoundError, PasswordRequiredError } from "@flatline/shared";
import { headers } from "next/headers";
import { cache } from "react";

import { apiBase } from "@/lib/api";
import { parseResolveHost, type HostState, type LoadOutcome } from "@/lib/status-snapshot";

/** One server-side read's deadline: a hung backend must not hang the page. */
const READ_TIMEOUT_MS = 10_000;

/**
 * A status page as the server reads it for its first render. The visitor's
 * cookies are forwarded, so a page they unlocked stays unlocked (the unlock
 * cookie is page-scoped and grants nothing else). Cached per request so the
 * page and its metadata share one read.
 */
export const readStatusPage = cache(async (slug: string): Promise<LoadOutcome> => {
    const cookie = (await headers()).get("cookie");
    try {
        const snapshot = await fetchStatusPage(apiBase(), slug, {
            cookie,
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        return { kind: "ok", snapshot };
    } catch (error) {
        if (error instanceof PasswordRequiredError) {
            return { kind: "locked" };
        }
        if (error instanceof NotFoundError) {
            return { kind: "notfound" };
        }
        return { kind: "error", message: "Could not load the status page." };
    }
});

/** Which status page, if any, the request's host serves (a client's branded domain). */
export async function resolveRequestHost(): Promise<HostState> {
    const raw = (await headers()).get("host") ?? "";
    const host = raw.replace(/:\d+$/, "").toLowerCase();
    if (!host) {
        return { kind: "unmapped" };
    }
    try {
        const response = await fetch(`${apiBase()}/api/status-page/resolve-host?host=${encodeURIComponent(host)}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        const body: unknown = response.ok ? await response.json() : null;
        return parseResolveHost(response.ok, body);
    } catch {
        return { kind: "error", message: "Could not reach the status server." };
    }
}
