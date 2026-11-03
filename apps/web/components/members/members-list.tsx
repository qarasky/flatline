"use client";

import {
    Avatar,
    Badge,
    EmptyState,
    IconButton,
    Menu,
    MenuContent,
    MenuItem,
    MenuSeparator,
    MenuTrigger,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TableRowHeader,
} from "@qarasky/kore-ui";
import { KeyRound, MoreHorizontal, UserMinus, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { RemoveMemberDialog } from "@/components/members/remove-member-dialog";
import { ResetPasswordDialog } from "@/components/members/reset-password-dialog";
import { type Member, type MemberStatus, memberStatus } from "@/lib/members";
import { PASSWORD_PATH } from "@/lib/session";

const STATUS: Record<MemberStatus, { label: string; tone: "warning" | "danger" } | null> = {
    active: null,
    "awaiting-first-sign-in": { label: "Awaiting first sign-in", tone: "warning" },
    "needs-reset": { label: "Needs a password reset", tone: "danger" },
};

type Action = { kind: "reset" | "remove"; member: Member } | null;

/** One row per member, with reset and remove behind the row's menu (change password on your own). */
export function MembersList({ members, meId }: { members: Member[]; meId: number | null }) {
    const [action, setAction] = useState<Action>(null);

    if (members.length === 0) {
        return (
            <EmptyState
                icon={<Users />}
                title="No members yet"
                description="Add the people who use Flatline. Until then, signing in needs a token."
            />
        );
    }

    return (
        <>
            <p className="text-meta text-muted mb-4">
                Every member is a full operator. Members who sign in with Kore ID are marked Kore ID.
            </p>
            <Table caption="Members">
                <TableHeader>
                    <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="max-sm:hidden">Email</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead align="right">Tokens</TableHead>
                        <TableHead className="w-12">
                            <span className="sr-only">Actions</span>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {members.map((member) => {
                        const status = STATUS[memberStatus(member)];
                        const own = member.id === meId;
                        return (
                            <TableRow key={member.id} data-member-id={member.id}>
                                <TableRowHeader>
                                    <div className="flex min-w-0 items-center gap-3">
                                        <Avatar name={member.name} email={member.email} size="sm" />
                                        <span className="min-w-0 truncate font-medium">{member.name}</span>
                                        {own ? <Badge tone="accent">You</Badge> : null}
                                        {member.sso ? <Badge tone="outline">Kore ID</Badge> : null}
                                    </div>
                                </TableRowHeader>
                                <TableCell muted className="max-w-72 truncate max-sm:hidden">
                                    {member.email}
                                </TableCell>
                                <TableCell>
                                    {status ? (
                                        <Badge tone={status.tone}>{status.label}</Badge>
                                    ) : (
                                        <span className="text-muted">Active</span>
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
                                    <Menu>
                                        <MenuTrigger asChild>
                                            <IconButton label={`${member.name}: actions`} icon={<MoreHorizontal />} />
                                        </MenuTrigger>
                                        <MenuContent align="end">
                                            {/* A reset would sign you out and hand you a starting password:
                                                your own row changes it instead. */}
                                            {own ? (
                                                <MenuItem asChild>
                                                    <Link href={PASSWORD_PATH}>
                                                        <KeyRound className="text-muted" />
                                                        Change password
                                                    </Link>
                                                </MenuItem>
                                            ) : (
                                                <MenuItem
                                                    icon={<KeyRound />}
                                                    onSelect={() => setAction({ kind: "reset", member })}
                                                >
                                                    Reset password…
                                                </MenuItem>
                                            )}
                                            {/* Nobody removes their own account: someone else does it. */}
                                            {!own && (
                                                <>
                                                    <MenuSeparator />
                                                    <MenuItem
                                                        danger
                                                        icon={<UserMinus />}
                                                        onSelect={() => setAction({ kind: "remove", member })}
                                                    >
                                                        Remove…
                                                    </MenuItem>
                                                </>
                                            )}
                                        </MenuContent>
                                    </Menu>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            {action?.kind === "reset" && <ResetPasswordDialog member={action.member} onClose={() => setAction(null)} />}
            {action?.kind === "remove" && (
                <RemoveMemberDialog member={action.member} members={members} onClose={() => setAction(null)} />
            )}
        </>
    );
}
