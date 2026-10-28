import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SectionPlaceholder } from "@/components/section-placeholder";

export const metadata: Metadata = { title: "Tokens · Flatline" };

export default function TokensPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Tokens" }]} />
            <SectionPlaceholder title="Tokens" part={5} />
        </>
    );
}
