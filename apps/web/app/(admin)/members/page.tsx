import { PageBody, PageHeader } from "@qarasky/kore-ui";
import type { Metadata } from "next";

import { MembersList } from "@/components/members/members-list";
import { api } from "@/lib/api";
import { currentMe } from "@/lib/auth-server";
import type { Member } from "@/lib/members";

export const metadata: Metadata = { title: "Members · KoreMonitor" };

export default async function MembersPage() {
    const [me, { users }] = await Promise.all([currentMe(), api<{ users: Member[] }>("/api/v1/users")]);
    return (
        <>
            <PageHeader title="Members" meta={`${users.length} member${users.length === 1 ? "" : "s"}`} />
            <PageBody>
                <MembersList members={users} meId={me.principal === "account" ? me.account.id : null} />
            </PageBody>
        </>
    );
}
