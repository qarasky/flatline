import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { ServersList } from "@/components/servers/servers-list";

export const metadata: Metadata = { title: "Servers · Flatline" };

export default function ServersPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Servers" }]} />
            <ServersList />
        </>
    );
}
