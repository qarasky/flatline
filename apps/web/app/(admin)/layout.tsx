import { cookies, headers } from "next/headers";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireOperator } from "@/lib/auth-server";
import { HOME_PATH, PATH_HEADER } from "@/lib/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const path = (await headers()).get(PATH_HEADER) ?? HOME_PATH;
    await requireOperator(path);

    // shadcn's sidebar remembers its state in this cookie; reading it here
    // renders the right width on the server, with no jump after load.
    const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";

    return (
        <SidebarProvider defaultOpen={defaultOpen}>
            <AppSidebar />
            <SidebarInset>{children}</SidebarInset>
        </SidebarProvider>
    );
}
