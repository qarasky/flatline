import type { Metadata } from "next";

import { AttentionList } from "@/components/attention/attention-list";
import { PageHeader } from "@qarasky/kore-ui";

export const metadata: Metadata = { title: "Attention · Flatline" };

export default function AttentionPage() {
    return (
        <>
            <PageHeader title="Attention" />
            <AttentionList />
        </>
    );
}
