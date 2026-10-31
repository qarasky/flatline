import "./legacy.css";

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { StatusNotice, StatusPageApp } from "@/components/status/status-page-app";
import { HOME_PATH, SESSION_COOKIE, SIGN_IN_PATH } from "@/lib/session";
import { readStatusPage, resolveRequestHost } from "@/lib/status-server";

export const metadata: Metadata = {
    robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

/**
 * The site root. A signed-in operator goes to Monitors (the gate already
 * did that). On a client's branded domain the request's host maps to a
 * status page, which renders here; any other signed-out visitor goes to
 * sign-in. A failed lookup never falls back to the operator UI: it says so
 * and tries again.
 */
export default async function Root() {
    if ((await cookies()).get(SESSION_COOKIE)?.value) {
        redirect(HOME_PATH);
    }
    const host = await resolveRequestHost();
    if (host.kind === "unmapped") {
        redirect(SIGN_IN_PATH);
    }
    if (host.kind === "mapped") {
        const initial = await readStatusPage(host.slug);
        return (
            <div className="legacy-theme">
                {initial.kind === "notfound" ? (
                    <StatusNotice>No status page found.</StatusNotice>
                ) : (
                    <StatusPageApp slug={host.slug} initial={initial} renderedAt={Date.now()} />
                )}
            </div>
        );
    }
    return (
        <div className="legacy-theme">
            {/* Try again on its own: an unattended screen may be showing this. */}
            <meta httpEquiv="refresh" content="30" />
            <StatusNotice>Could not reach the status server. Retrying…</StatusNotice>
        </div>
    );
}
