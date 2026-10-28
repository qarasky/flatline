import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SectionPlaceholder } from "@/components/section-placeholder";

export const metadata: Metadata = { title: "Servers · Flatline" };

export default function ServersPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Servers" }]} />
            <SectionPlaceholder title="Servers" part={3} />
        </>
    );
}
