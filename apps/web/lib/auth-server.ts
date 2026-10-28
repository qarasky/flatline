import "server-only";

import { api } from "@/lib/api";

/**
 * Check the session cookie for real (the proxy only saw that it exists). A
 * token the API rejects sends the operator to sign in again: `api()` does that
 * for every server-side call.
 */
export async function requireOperator(): Promise<void> {
    await api("/api/v1/auth/me");
}
