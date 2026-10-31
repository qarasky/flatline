import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { BoardDataProvider } from "@/components/board/board-data";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireOperator } from "@/lib/auth-server";
import type { MonitorSummary } from "@/lib/monitor-types";
import { fetchAllMonitors } from "@/lib/monitors-api";

/** The roster for the first render, or null to let the browser load it. */
async function initialRoster(): Promise<MonitorSummary[] | null> {
    try {
        return await fetchAllMonitors();
    } catch (error) {
        // A redirect (signed out, password change) must still happen.
        unstable_rethrow(error);
        // Any other failure must not take down pages that do not need monitors.
        return null;
    }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const me = await requireOperator();
    const roster = await initialRoster();

    // shadcn's sidebar remembers its state in this cookie; reading it here
    // renders the right width on the server, with no jump after load.
    const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";

    return (
        <BoardDataProvider initialMonitors={roster} renderedAt={Date.now()}>
            <SidebarProvider defaultOpen={defaultOpen}>
                <AppSidebar me={me} />
                <SidebarInset>{children}</SidebarInset>
            </SidebarProvider>
            <CommandPalette me={me} />
        </BoardDataProvider>
    );
}
