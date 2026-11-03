import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { AdminShell } from "@/components/app-shell";
import { BoardDataProvider } from "@/components/board/board-data";
import { CommandPalette } from "@/components/command-palette";
import { LiveUpdateWatcher } from "@/components/live-update-watcher";
import { api } from "@/lib/api";
import { requireOperator } from "@/lib/auth-server";
import { SIDEBAR_COOKIE } from "@/lib/kore";
import type { MonitorSummary } from "@/lib/monitor-types";
import { fetchAllMonitors } from "@/lib/monitors-api";
import { NO_SIGN_IN, type SignInMethods, toMethods } from "@/lib/sso";

/** The roster for the first render, or null to let the browser load it. */
async function initialRoster(): Promise<MonitorSummary[] | null> {
    try {
        return await fetchAllMonitors();
    } catch (error) {
        // A redirect (signed out) must still happen.
        unstable_rethrow(error);
        // Any other failure must not take down pages that do not need monitors.
        return null;
    }
}

/** Kore ID's account page and the other Kore apps, for the account menu and app switcher. */
async function signInMethods(): Promise<SignInMethods> {
    try {
        return toMethods(await api<Record<string, unknown>>("/api/v1/auth/sso/config"));
    } catch (error) {
        unstable_rethrow(error);
        return NO_SIGN_IN;
    }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const me = await requireOperator();
    const [roster, methods] = await Promise.all([initialRoster(), signInMethods()]);

    // The collapsed sidebar is remembered in a cookie; reading it here
    // renders the right width on the server, with no jump after load.
    const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "false";

    return (
        <BoardDataProvider initialMonitors={roster} renderedAt={Date.now()}>
            <AdminShell me={me} methods={methods} defaultCollapsed={collapsed}>
                {children}
            </AdminShell>
            <CommandPalette me={me} />
            <LiveUpdateWatcher mode="prompt" />
        </BoardDataProvider>
    );
}
