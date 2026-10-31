import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { SuperboardClient } from "@/components/superboard/superboard-client";
import { LiveUpdateWatcher } from "@/components/live-update-watcher";
import { boardRouteFrom } from "@/lib/routes";
import { SESSION_COOKIE } from "@/lib/session";

export const metadata: Metadata = { title: "Superboard · Flatline" };

/**
 * `/superboard`, `/superboard/<scope>`, `/superboard/kiosk` and
 * `/superboard/kiosk/<groups>`. A signed-out kiosk shows its QR sign-in in
 * place; the gate sends a signed-out desk board to the sign-in page.
 */
export default async function SuperboardPage({ params }: { params: Promise<{ path?: string[] }> }) {
    const { path = [] } = await params;
    const route = boardRouteFrom(`/superboard${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}`);
    if (!route) {
        notFound();
    }
    const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
    return (
        <>
            <SuperboardClient kiosk={route.kiosk} filter={route.filter} signedOut={!signedIn} />
            {/* The wall reloads itself after a deploy; the desk board asks. */}
            <LiveUpdateWatcher mode={route.kiosk ? "reload" : "prompt"} />
        </>
    );
}
