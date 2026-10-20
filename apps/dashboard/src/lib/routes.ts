/**
 * Path parsing for the top-level routes.
 *
 * Kept free of imports so the entry chunk (App.tsx) can decide which lazy
 * route to load without pulling any view code in with it.
 */

export interface BoardRoute {
    kiosk: boolean;
    /** Raw group filter segment, e.g. "work" or "work,personal". Null for the whole fleet. */
    filter: string | null;
}

/**
 * Resolve a path to a board route, if it is one.
 *
 * /superboard and /superboard/kiosk show the whole fleet; appending a
 * group segment scopes the board, e.g. /superboard/kiosk/work. Anything
 * else (the table, invites) is not a board route.
 */
export function boardRouteFrom(path: string): BoardRoute | null {
    const clean = path.replace(/\/+$/, "") || "/";
    if (clean === "/superboard") {
        return { kiosk: false, filter: null };
    }
    if (clean === "/superboard/kiosk") {
        return { kiosk: true, filter: null };
    }
    let match = /^\/superboard\/kiosk\/(.+)$/.exec(clean);
    if (match) {
        return { kiosk: true, filter: decodeSegment(match[1]) };
    }
    match = /^\/superboard\/([^/]+)$/.exec(clean);
    if (match) {
        // /superboard/kiosk is handled above; anything else here is a scope.
        // (So do not name a group "kiosk": the desk URL would lose to it.)
        return { kiosk: false, filter: decodeSegment(match[1]) };
    }
    return null;
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Pull a status page slug out of `/status/:slug`.
 *
 * Public route: no operator token is involved, and the API decides what the
 * caller may see (password-gated pages show the unlock form).
 * @param path Current path
 * @returns Decoded slug, or null when this is not a status route
 */
export function statusSlugFromPath(path: string): string | null {
    const clean = path.replace(/\/+$/, "") || "/";
    const match = /^\/status\/([^/]+)$/.exec(clean);
    if (!match) {
        return null;
    }
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}
