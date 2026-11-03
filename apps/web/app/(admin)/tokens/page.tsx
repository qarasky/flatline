import { PageBody, PageHeader } from "@qarasky/kore-ui";
import type { Metadata } from "next";

import { TokensList } from "@/components/tokens/tokens-list";
export const metadata: Metadata = { title: "Tokens · KoreMonitor" };

export default async function TokensPage() {
    return (
        <>
            <PageHeader title="Tokens" />
            <PageBody>
                <TokensList />
            </PageBody>
        </>
    );
}
