import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SectionPlaceholder } from "@/components/section-placeholder";

export const metadata: Metadata = { title: "Attention · Flatline" };

export default function AttentionPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Attention" }]} />
            <SectionPlaceholder title="Attention" part={2} />
        </>
    );
}
