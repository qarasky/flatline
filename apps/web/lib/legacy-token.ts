import { api, isApiError } from "@/lib/api";
import { LEGACY_TOKEN_KEY } from "@/lib/session";

export type SessionResult = "ok" | "rejected" | "error";

/** Start a browser session (`POST /api/v1/auth/session`) from a token. */
export async function createSession(token: string): Promise<SessionResult> {
    try {
        await api("/api/v1/auth/session", { method: "POST", body: { token } });
        return "ok";
    } catch (error) {
        return isApiError(error, 401) ? "rejected" : "error";
    }
}

/**
 * Turn a token the old dashboard left in `localStorage` into a session, so
 * a screen nobody sits at (the wall TV) comes back signed in after the
 * switch. A revoked token is forgotten; a token that could not be checked
 * (network, 5xx) is kept for the next visit.
 */
export async function migrateLegacyToken(deps: {
    storage: Pick<Storage, "getItem" | "removeItem">;
    createSession: (token: string) => Promise<SessionResult>;
}): Promise<"migrated" | "none" | "rejected" | "error"> {
    let token: string | null;
    try {
        token = deps.storage.getItem(LEGACY_TOKEN_KEY);
    } catch {
        return "none";
    }
    if (!token) {
        return "none";
    }

    const result = await deps.createSession(token);
    if (result === "error") {
        return "error";
    }
    try {
        deps.storage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
        // Unwritable storage: the session cookie is what matters now.
    }
    return result === "ok" ? "migrated" : "rejected";
}

/** What the sign-in form says when signing in failed. */
export function signInMessage(error: unknown): string {
    // An unreachable or busy server is "try again"; anything else the API
    // explains itself (an agent token, for one, says so explicitly).
    if (isApiError(error) && error.status !== 503 && error.message) {
        return error.message;
    }
    return "Could not reach Flatline. Try again.";
}
