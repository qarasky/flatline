import { BOARD_KEYS } from "@/lib/board-url";
import { safeNext } from "@/lib/safe-next";
import { HOME_PATH, SIGN_IN_PATH } from "@/lib/session";

export type GateResult = { kind: "next" } | { kind: "redirect"; to: string };

/**
 * The optimistic sign-in gate run by `proxy.ts`. It only knows whether a
 * session cookie is present; server layouts check the token for real and
 * send a rejected one to `/sign-in?expired=1`, which this lets through so a
 * dead cookie cannot bounce between the two.
 */
export function gate(pathname: string, search: string, hasSession: boolean): GateResult {
    const params = new URLSearchParams(search);

    if (pathname === SIGN_IN_PATH) {
        if (hasSession && !params.has("expired")) {
            return { kind: "redirect", to: safeNext(params.get("next")) };
        }
        return { kind: "next" };
    }

    if (!hasSession) {
        return { kind: "redirect", to: `${SIGN_IN_PATH}?next=${encodeURIComponent(pathname + search)}` };
    }

    if (pathname === "/") {
        return { kind: "redirect", to: legacyRoot(params) };
    }

    return { kind: "next" };
}

/**
 * Where an old dashboard link to `/` goes: `?m=ID` opens that monitor's own
 * page, and the board's filters and sort carry over to Monitors. Anything
 * else in the query is left behind.
 */
function legacyRoot(params: URLSearchParams): string {
    const id = params.get("m");
    if (id && /^[1-9][0-9]*$/.test(id)) {
        return `${HOME_PATH}/${id}`;
    }
    const kept = new URLSearchParams();
    for (const key of BOARD_KEYS) {
        const value = params.get(key);
        if (key !== "m" && value) {
            kept.set(key, value);
        }
    }
    const query = kept.toString();
    return query ? `${HOME_PATH}?${query}` : HOME_PATH;
}
