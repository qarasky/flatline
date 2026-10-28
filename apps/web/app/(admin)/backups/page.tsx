import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SectionPlaceholder } from "@/components/section-placeholder";

export const metadata: Metadata = { title: "Backups · Flatline" };

export default function BackupsPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Backups" }]} />
            <SectionPlaceholder title="Backups" part={3} />
        </>
    );
}
