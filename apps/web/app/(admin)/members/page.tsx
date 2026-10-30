import type { Metadata } from "next";

import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { MembersList } from "@/components/members/members-list";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";
import { currentMe } from "@/lib/auth-server";
import type { Member } from "@/lib/members";

export const metadata: Metadata = { title: "Members · Flatline" };

export default async function MembersPage() {
    const [me, { users }] = await Promise.all([currentMe(), api<{ users: Member[] }>("/api/v1/users")]);
    return (
        <>
            <PageHeader crumbs={[{ label: "Members" }]} actions={<AddMemberDialog />} />
            <MembersList members={users} meId={me.principal === "account" ? me.account.id : null} />
        </>
    );
}
