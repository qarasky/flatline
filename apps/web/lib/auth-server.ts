import "server-only";

import { api } from "@/lib/api";
import { type Me, toMe } from "@/lib/me";

/** Who is signed in, checked against the API (the proxy only saw a cookie). */
export async function currentMe(): Promise<Me> {
    return toMe(await api<Record<string, unknown>>("/api/v1/auth/me"));
}

/**
 * Check the session for real. A session the API rejects sends the person to
 * sign in again (`api()` does that for every server-side call).
 */
export async function requireOperator(): Promise<Me> {
    return currentMe();
}
