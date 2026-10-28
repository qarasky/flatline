import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SectionPlaceholder } from "@/components/section-placeholder";

export const metadata: Metadata = { title: "Monitors · Flatline" };

export default function MonitorsPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Monitors" }]} />
            <SectionPlaceholder title="Monitors" part={2} />
        </>
    );
}
