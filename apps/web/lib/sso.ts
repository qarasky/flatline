import { api } from "@/lib/api";

/** What the sign-in page offers, from `GET /api/v1/auth/sso/config`. */
export interface SignInMethods {
    sso: boolean;
    localLogin: boolean;
    tokenLogin: boolean;
}

/** Local sign-in only, for a backend that does not answer. */
export const LOCAL_ONLY: SignInMethods = { sso: false, localLogin: true, tokenLogin: true };

export function toMethods(body: Record<string, unknown>): SignInMethods {
    return {
        sso: body.sso === true,
        localLogin: body.localLogin !== false,
        tokenLogin: body.tokenLogin !== false,
    };
}

/** The backend route that starts Kore ID sign-in; `next` is a local path. */
export function ssoStartHref(next: string | null): string {
    return next && next.startsWith("/")
        ? `/api/v1/auth/sso/start?next=${encodeURIComponent(next)}`
        : "/api/v1/auth/sso/start";
}

const SSO_ERRORS: Record<string, string> = {
    denied: "This Kore ID account is not allowed to use Flatline. Ask an operator to add it.",
    state: "That sign-in link expired or was opened in another browser. Try again.",
    token: "Kore ID returned a token Flatline could not verify. Try again.",
    provider: "Kore ID did not complete the sign-in. Try again.",
    unavailable: "Kore ID could not be reached. Try again in a moment.",
    disabled: "Kore ID sign-in is not set up on this instance.",
};

/** The sentence for `/sign-in?sso_error=<code>`, or null when there is none. */
export function ssoErrorMessage(code: string | null | undefined): string | null {
    if (!code) {
        return null;
    }
    return SSO_ERRORS[code] ?? "Kore ID sign-in failed. Try again.";
}

/**
 * End the session. When it came from Kore ID the backend returns the
 * provider's end-session URL; the caller sends the browser there so the
 * single sign-on session ends too (it returns to `/sign-in`).
 */
export async function endSession(): Promise<string | null> {
    try {
        const answer = await api<{ ssoLogoutUrl?: string }>("/api/v1/auth/session", { method: "DELETE" });
        const url = answer?.ssoLogoutUrl;
        return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
    } catch {
        return null;
    }
}
