import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { TokensList } from "@/components/tokens/tokens-list";
import { currentMe } from "@/lib/auth-server";

export const metadata: Metadata = { title: "Tokens · Flatline" };

export default async function TokensPage() {
    const me = await currentMe();
    return (
        <>
            <PageHeader crumbs={[{ label: "Tokens" }]} />
            <TokensList me={me} />
        </>
    );
}
