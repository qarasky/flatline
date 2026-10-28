import "server-only";

import { redirect } from "next/navigation";

import { api, isApiError } from "@/lib/api";
import { SIGN_IN_PATH } from "@/lib/session";

/**
 * Check the session cookie for real (the proxy only saw that it exists).
 * A token the API rejects sends the operator to sign in again, marked
 * `expired` so the gate does not bounce them straight back.
 */
export async function requireOperator(path: string): Promise<void> {
    try {
        await api("/api/v1/auth/me");
    } catch (error) {
        if (isApiError(error, 401)) {
            redirect(`${SIGN_IN_PATH}?expired=1&next=${encodeURIComponent(path)}`);
        }
        throw error;
    }
}
