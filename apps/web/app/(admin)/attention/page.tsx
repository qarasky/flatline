import type { Metadata } from "next";

import { AttentionList } from "@/components/attention/attention-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Attention · Flatline" };

export default function AttentionPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Attention" }]} />
            <AttentionList />
        </>
    );
}
