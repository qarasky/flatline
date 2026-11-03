"use client";

import {
    Avatar,
    Badge,
    EmptyState,
    IconButton,
    Menu,
    MenuContent,
    MenuItem,
    MenuTrigger,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TableRowHeader,
} from "@qarasky/kore-ui";
import { MoreHorizontal, UserMinus, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { RemoveMemberDialog } from "@/components/members/remove-member-dialog";
import { type Member } from "@/lib/members";

/** One row per member, with remove behind the row's menu for someone else. */
export function MembersList({ members, meId }: { members: Member[]; meId: number | null }) {
    const [removing, setRemoving] = useState<Member | null>(null);

    if (members.length === 0) {
        return (
            <EmptyState
                icon={<Users />}
                title="No members yet"
                description="People appear here after their first Kore ID sign-in. To give someone access, grant them the flatline app in Kore ID."
            />
        );
    }

    return (
        <>
            <p className="text-meta text-muted mb-4">
                Every member is a full operator. Access comes from Kore ID: grant the flatline app there, and remove the
                account here when someone leaves.
            </p>
            <Table caption="Members">
                <TableHeader>
                    <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="max-sm:hidden">Email</TableHead>
                        <TableHead>Sign-in</TableHead>
                        <TableHead align="right">Tokens</TableHead>
                        <TableHead className="w-12">
                            <span className="sr-only">Actions</span>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {members.map((member) => {
                        const own = member.id === meId;
                        return (
                            <TableRow key={member.id} data-member-id={member.id}>
                                <TableRowHeader>
                                    <div className="flex min-w-0 items-center gap-3">
                                        <Avatar name={member.name} email={member.email} size="sm" />
                                        <span className="min-w-0 truncate font-medium">{member.name}</span>
                                        {own ? <Badge tone="accent">You</Badge> : null}
                                    </div>
                                </TableRowHeader>
                                <TableCell muted className="max-w-72 truncate max-sm:hidden">
                                    {member.email}
                                </TableCell>
                                <TableCell>
                                    {member.sso ? (
                                        <Badge tone="outline">Kore ID</Badge>
                                    ) : (
                                        <span className="text-muted">Linked on next sign-in</span>
                                    )}
                                </TableCell>
                                <TableCell align="right" muted>
                                    {member.tokenCount > 0 ? (
                                        <Link href="/tokens" className="hover:text-text hover:underline">
                                            {member.tokenCount} token{member.tokenCount === 1 ? "" : "s"}
                                        </Link>
                                    ) : (
                                        "—"
                                    )}
                                </TableCell>
                                <TableCell align="right">
                                    {/* Nobody removes their own account: someone else does it. */}
                                    {!own ? (
                                        <Menu>
                                            <MenuTrigger asChild>
                                                <IconButton
                                                    label={`${member.name}: actions`}
                                                    icon={<MoreHorizontal />}
                                                />
                                            </MenuTrigger>
                                            <MenuContent align="end">
                                                <MenuItem
                                                    danger
                                                    icon={<UserMinus />}
                                                    onSelect={() => setRemoving(member)}
                                                >
                                                    Remove…
                                                </MenuItem>
                                            </MenuContent>
                                        </Menu>
                                    ) : null}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            {removing && <RemoveMemberDialog member={removing} members={members} onClose={() => setRemoving(null)} />}
        </>
    );
}
