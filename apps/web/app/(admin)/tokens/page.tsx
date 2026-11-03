import { PageBody, PageHeader } from "@qarasky/kore-ui";
import type { Metadata } from "next";

import { TokensList } from "@/components/tokens/tokens-list";
import { currentMe } from "@/lib/auth-server";

export const metadata: Metadata = { title: "Tokens · Flatline" };

export default async function TokensPage() {
    const me = await currentMe();
    return (
        <>
            <PageHeader title="Tokens" />
            <PageBody>
                <TokensList me={me} />
            </PageBody>
        </>
    );
}
