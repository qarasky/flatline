import { api } from "@/lib/api";

/**
 * What the sign-in page offers, from `GET /api/v1/auth/sso/config`, and for
 * the account menu the Kore ID account page and the other Kore apps.
 */
export interface SignInMethods {
    /** Kore ID sign-in is configured. */
    sso: boolean;
    /** Kore ID's account page (with Kore ID on). */
    accountUrl: string | null;
    /** The other Kore apps' URLs for the app switcher, by app id. */
    apps: Partial<Record<KoreAppId, string>>;
}

/** The Kore apps the switcher knows (kore-ui's `AppId`). */
export type KoreAppId = "kore" | "koremind" | "korecalendar" | "flatline";
const APP_IDS: readonly KoreAppId[] = ["kore", "koremind", "korecalendar", "flatline"];

/** No sign-in method: the backend did not answer, or Kore ID is not configured. */
export const NO_SIGN_IN: SignInMethods = { sso: false, accountUrl: null, apps: {} };

export function toMethods(body: Record<string, unknown>): SignInMethods {
    const apps: SignInMethods["apps"] = {};
    const raw = body.apps && typeof body.apps === "object" ? (body.apps as Record<string, unknown>) : {};
    for (const id of APP_IDS) {
        const url = raw[id];
        if (typeof url === "string" && /^https?:\/\//.test(url)) {
            apps[id] = url;
        }
    }
    const accountUrl =
        typeof body.accountUrl === "string" && /^https?:\/\//.test(body.accountUrl) ? body.accountUrl : null;
    return {
        sso: body.sso === true,
        accountUrl,
        apps,
    };
}

/** The backend route that starts Kore ID sign-in; `next` is a local path. */
export function ssoStartHref(next: string | null): string {
    return next && next.startsWith("/")
        ? `/api/v1/auth/sso/start?next=${encodeURIComponent(next)}`
        : "/api/v1/auth/sso/start";
}

const SSO_ERRORS: Record<string, string> = {
    denied: "This Kore ID account doesn't have access to KoreMonitor. Ask your Kore ID admin to give you access.",
    state: "That sign-in link expired or was opened in another browser. Try again.",
    token: "Kore ID returned a token KoreMonitor could not verify. Try again.",
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
