"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { signInMessage as failureMessage } from "@/lib/legacy-token";
import { type Member, type MemberToken, removalWarning } from "@/lib/members";

/**
 * Remove a member. Their active tokens are listed, all ticked: revoking them
 * is the default, and a screen the office still needs can be kept.
 */
export function RemoveMemberDialog({
    member,
    members,
    onClose,
}: {
    member: Member;
    members: Member[];
    onClose: () => void;
}) {
    const router = useRouter();
    const [tokens, setTokens] = useState<MemberToken[] | null>(null);
    const [revoke, setRevoke] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const warning = removalWarning(members, member.id);

    useEffect(() => {
        let cancelled = false;
        api<{ tokens: MemberToken[] }>(`/api/v1/users/${member.id}`)
            .then(({ tokens }) => {
                if (cancelled) {
                    return;
                }
                const active = tokens.filter((token) => token.active);
                setTokens(active);
                setRevoke(new Set(active.map((token) => token.id)));
            })
            .catch((failure: unknown) => !cancelled && setError(failureMessage(failure)));
        return () => {
            cancelled = true;
        };
    }, [member.id]);

    function toggle(id: number, checked: boolean) {
        setRevoke((current) => {
            const next = new Set(current);
            if (checked) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    }

    async function remove() {
        setBusy(true);
        setError(null);
        try {
            await api(`/api/v1/users/${member.id}`, {
                method: "DELETE",
                body: { revokeTokenIds: [...revoke] },
            });
            onClose();
            router.refresh();
        } catch (failure) {
            setError(failureMessage(failure));
            setBusy(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Remove {member.name}?</DialogTitle>
                    <DialogDescription>
                        {member.email} is signed out everywhere and can no longer sign in.
                    </DialogDescription>
                </DialogHeader>

                {tokens === null && !error && <p className="text-muted-foreground">Loading their tokens…</p>}
                {tokens !== null && tokens.length > 0 && (
                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-2">Revoke the tokens they made</legend>
                        {tokens.map((token) => (
                            <label key={token.id} className="flex items-center gap-2.5">
                                <Checkbox
                                    checked={revoke.has(token.id)}
                                    onCheckedChange={(checked) => toggle(token.id, checked === true)}
                                />
                                <span className="truncate">{token.name}</span>
                            </label>
                        ))}
                        <p className="text-muted-foreground">An unticked token keeps working.</p>
                    </fieldset>
                )}
                {warning && <p className="text-status-warn">{warning}</p>}
                {error && (
                    <p role="alert" className="text-status-down">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="button" variant="destructive" disabled={busy || tokens === null} onClick={remove}>
                        {busy ? "Removing…" : "Remove member"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
