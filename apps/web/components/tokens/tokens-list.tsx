"use client";

import {
    Badge,
    ConfirmDialog,
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
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TableRowHeader,
} from "@qarasky/kore-ui";
import { KeyRound, MoreHorizontal, Power, PowerOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useClock } from "@/hooks/use-clock";
import type { Me } from "@/lib/me";
import { tokenRow, type TokenKey } from "@/lib/token-row";
import { deleteToken, fetchTokens, setTokenActive } from "@/lib/tokens-api";

import { MintTokenDialog } from "./mint-token-dialog";

type Pending = { kind: "disable" | "delete"; key: TokenKey } | null;

const STATUS = {
    active: { label: "Active", tone: "success" },
    disabled: { label: "Disabled", tone: "neutral" },
    expired: { label: "Expired", tone: "warning" },
} as const;

/** The SQL timestamp's date part. */
const day = (value: string) => value.slice(0, 10);

/**
 * Operator tokens: who made each, when it was last used, and the actions on
 * it. Device sign-ins (the kiosk's QR) are tokens too, named after the screen.
 */
export function TokensList({ me }: { me: Me }) {
    const now = useClock(30_000);
    const [keys, setKeys] = useState<TokenKey[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The pending action stays after the dialog closes, so its text holds while it fades out.
    const [pending, setPending] = useState<Pending>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const ask = (next: NonNullable<Pending>) => {
        setPending(next);
        setConfirmOpen(true);
    };

    const load = useCallback(async () => {
        try {
            setKeys(await fetchTokens());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Couldn't load the tokens. Reload the page to try again.");
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);

    async function run(action: () => Promise<unknown>, signsOut: boolean) {
        try {
            await action();
            if (signsOut) {
                // This browser's session stopped with its token: reloading lands on sign-in.
                window.location.reload();
                return;
            }
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "The change didn't go through. Try again.");
        }
    }

    const pendingCurrent = pending !== null && tokenRow(pending.key, me, now).isCurrent;
    const verb = pending?.kind === "disable" ? "Disable" : "Delete";
    return (
        <section aria-label="Tokens" className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <p className="text-meta text-muted min-w-0 flex-1">
                    Operator tokens can do everything a member can. Agents use their own tokens.
                </p>
                <MintTokenDialog onMinted={() => void load()} />
            </div>
            {error ? (
                <p role="alert" className="text-meta text-danger">
                    {error}
                </p>
            ) : null}
            {keys !== null && keys.length === 0 ? (
                <EmptyState
                    icon={<KeyRound />}
                    title="No tokens yet"
                    description="Make one for a script, the API or a screen that signs in without an account."
                />
            ) : (
                <Table caption="Operator tokens">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="max-sm:hidden">Made by</TableHead>
                            <TableHead className="max-sm:hidden">Created</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead className="max-sm:hidden">Expires</TableHead>
                            <TableHead className="w-12">
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {keys === null ? (
                            <TableEmpty colSpan={7}>Loading…</TableEmpty>
                        ) : (
                            keys.map((key) => {
                                const row = tokenRow(key, me, now);
                                const status = STATUS[row.status];
                                const toggle = key.active ? (
                                    <MenuItem
                                        icon={<PowerOff />}
                                        onSelect={() =>
                                            row.isCurrent
                                                ? ask({ kind: "disable", key })
                                                : void run(() => setTokenActive(key.id, false), false)
                                        }
                                    >
                                        {row.isCurrent ? "Disable…" : "Disable"}
                                    </MenuItem>
                                ) : row.status === "expired" ? null : (
                                    <MenuItem
                                        icon={<Power />}
                                        onSelect={() => void run(() => setTokenActive(key.id, true), false)}
                                    >
                                        Enable
                                    </MenuItem>
                                );
                                return (
                                    <TableRow key={key.id} data-token-id={key.id}>
                                        <TableRowHeader>
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className="max-w-72 truncate font-medium">{key.name}</span>
                                                {row.isCurrent ? <Badge tone="accent">This browser</Badge> : null}
                                            </div>
                                        </TableRowHeader>
                                        <TableCell>
                                            <Badge tone={status.tone}>{status.label}</Badge>
                                        </TableCell>
                                        <TableCell muted className="max-sm:hidden">
                                            {row.maker}
                                        </TableCell>
                                        <TableCell muted className="tabular-nums max-sm:hidden">
                                            {day(key.createdDate)}
                                        </TableCell>
                                        <TableCell muted className="tabular-nums">
                                            {row.lastUsed}
                                        </TableCell>
                                        <TableCell muted className="tabular-nums max-sm:hidden">
                                            {row.expires}
                                        </TableCell>
                                        <TableCell align="right">
                                            <Menu>
                                                <MenuTrigger asChild>
                                                    <IconButton
                                                        label={`Actions for ${key.name}`}
                                                        icon={<MoreHorizontal />}
                                                    />
                                                </MenuTrigger>
                                                <MenuContent align="end">
                                                    {toggle}
                                                    {toggle ? <MenuSeparator /> : null}
                                                    <MenuItem
                                                        danger
                                                        icon={<Trash2 />}
                                                        onSelect={() => ask({ kind: "delete", key })}
                                                    >
                                                        Delete…
                                                    </MenuItem>
                                                </MenuContent>
                                            </Menu>
                                        </TableCell>
                                    </TableRow>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
            )}
            <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                danger
                title={`${verb} “${pending?.key.name ?? ""}”?`}
                description={
                    (pendingCurrent
                        ? "This browser signed in with it, so it signs this browser out."
                        : "Anything using it stops working at its next request.") +
                    (pending?.kind === "delete" ? " Deleting can't be undone." : "")
                }
                confirmLabel={verb}
                onConfirm={async () => {
                    if (!pending) {
                        return;
                    }
                    const { kind, key } = pending;
                    await run(
                        () => (kind === "delete" ? deleteToken(key.id) : setTokenActive(key.id, false)),
                        pendingCurrent
                    );
                }}
            />
        </section>
    );
}
