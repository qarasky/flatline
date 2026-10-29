import "server-only";

import { redirect } from "next/navigation";

import { api } from "@/lib/api";
import { type Me, toMe } from "@/lib/me";
import { PASSWORD_PATH } from "@/lib/session";

/** Who is signed in, checked against the API (the proxy only saw a cookie). */
export async function currentMe(): Promise<Me> {
    return toMe(await api<Record<string, unknown>>("/api/v1/auth/me"));
}

/**
 * Check the session for real. A session the API rejects sends the person to
 * sign in again (`api()` does that for every server-side call); an account
 * still on its starting password goes to choose its own first.
 */
export async function requireOperator(): Promise<Me> {
    const me = await currentMe();
    if (me.principal === "account" && me.account.mustChangePassword) {
        redirect(PASSWORD_PATH);
    }
    return me;
}
