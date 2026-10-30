"use client";

import { Ellipsis, KeyRound, UserMinus } from "lucide-react";
import { useState } from "react";

import { RemoveMemberDialog } from "@/components/members/remove-member-dialog";
import { ResetPasswordDialog } from "@/components/members/reset-password-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initials } from "@/lib/me";
import { type Member, type MemberStatus, memberStatus } from "@/lib/members";

const STATUS: Record<MemberStatus, { label: string; className: string } | null> = {
    active: null,
    "awaiting-first-sign-in": { label: "Awaiting first sign-in", className: "text-status-warn" },
    "needs-reset": { label: "Needs a password reset", className: "text-status-down" },
};

type Action = { kind: "reset" | "remove"; member: Member } | null;

/** One dense row per member, with reset and remove behind the row's menu. */
export function MembersList({ members, meId }: { members: Member[]; meId: number | null }) {
    const [action, setAction] = useState<Action>(null);

    if (members.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center p-10">
                <p className="text-muted-foreground max-w-sm text-center">
                    No members yet. Add the people who use Flatline; until then, signing in needs a token.
                </p>
            </div>
        );
    }

    return (
        <>
            <ul aria-label="Members" className="divide-y">
                {members.map((member) => {
                    const status = STATUS[memberStatus(member)];
                    const own = member.id === meId;
                    return (
                        <li key={member.id} className="flex h-11 items-center gap-3 px-4">
                            <span className="bg-raised flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-medium">
                                {initials(member.name)}
                            </span>
                            <span className="min-w-0 truncate font-medium">
                                {member.name}
                                {own && <span className="text-muted-foreground font-normal"> (you)</span>}
                            </span>
                            <span className="text-muted-foreground min-w-0 flex-1 truncate">{member.email}</span>
                            {status && (
                                <Badge variant="outline" className={status.className}>
                                    {status.label}
                                </Badge>
                            )}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-7"
                                        aria-label={`${member.name}: actions`}
                                    >
                                        <Ellipsis />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-44">
                                    <DropdownMenuItem onSelect={() => setAction({ kind: "reset", member })}>
                                        <KeyRound />
                                        Reset password
                                    </DropdownMenuItem>
                                    {/* Nobody removes their own account: someone else does it. */}
                                    {!own && (
                                        <DropdownMenuItem
                                            variant="destructive"
                                            onSelect={() => setAction({ kind: "remove", member })}
                                        >
                                            <UserMinus />
                                            Remove
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </li>
                    );
                })}
            </ul>

            {action?.kind === "reset" && <ResetPasswordDialog member={action.member} onClose={() => setAction(null)} />}
            {action?.kind === "remove" && (
                <RemoveMemberDialog member={action.member} members={members} onClose={() => setAction(null)} />
            )}
        </>
    );
}
