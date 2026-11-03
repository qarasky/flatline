import type { Metadata } from "next";

import { PageHeader } from "@qarasky/kore-ui";
import { ServersList } from "@/components/servers/servers-list";

export const metadata: Metadata = { title: "Servers · Flatline" };

export default function ServersPage() {
    return (
        <>
            <PageHeader title="Servers" />
            <ServersList />
        </>
    );
}
