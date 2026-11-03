"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Checkbox, ConfirmDialog } from "@qarasky/kore-ui";
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
        setError(null);
        try {
            await api(`/api/v1/users/${member.id}`, {
                method: "DELETE",
                body: { revokeTokenIds: [...revoke] },
            });
            router.refresh();
        } catch (failure) {
            setError(failureMessage(failure));
            // Keeps the dialog open with the error.
            throw failure;
        }
    }

    return (
        <ConfirmDialog
            open
            onOpenChange={(open) => !open && onClose()}
            danger
            title={`Remove “${member.name}”?`}
            description={`${member.email} is signed out everywhere and can no longer sign in.`}
            confirmLabel="Remove"
            pendingLabel="Removing…"
            confirmDisabled={tokens === null}
            onConfirm={remove}
        >
            <div className="flex flex-col gap-3">
                {tokens === null && !error && <p className="text-muted">Loading their tokens…</p>}
                {tokens !== null && tokens.length > 0 && (
                    <fieldset className="flex flex-col gap-1">
                        <legend className="text-meta text-muted mb-1 font-medium">Revoke the tokens they made</legend>
                        {tokens.map((token) => (
                            <Checkbox
                                key={token.id}
                                label={<span className="truncate">{token.name}</span>}
                                checked={revoke.has(token.id)}
                                onCheckedChange={(checked) => toggle(token.id, checked === true)}
                            />
                        ))}
                        <p className="text-meta text-muted">An unticked token keeps working.</p>
                    </fieldset>
                )}
                {warning && <p className="text-warning">{warning}</p>}
                {error && (
                    <p role="alert" className="text-danger">
                        {error}
                    </p>
                )}
            </div>
        </ConfirmDialog>
    );
}
