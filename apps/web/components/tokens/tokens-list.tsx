"use client";

import { Ellipsis } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useClock } from "@/hooks/use-clock";
import type { Me } from "@/lib/me";
import { tokenRow, type TokenKey } from "@/lib/token-row";
import { deleteToken, fetchTokens, setTokenActive } from "@/lib/tokens-api";
import { cn } from "@/lib/utils";

import { MintTokenDialog } from "./mint-token-dialog";

type Pending = { kind: "disable" | "delete"; key: TokenKey } | null;

const STATUS_CLASS = {
    active: "text-status-up",
    disabled: "text-muted-foreground",
    expired: "text-status-warn",
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
    const [pending, setPending] = useState<Pending>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            setKeys(await fetchTokens());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load the tokens.");
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);

    async function run(action: () => Promise<unknown>, signsOut: boolean) {
        setBusy(true);
        try {
            await action();
            setPending(null);
            if (signsOut) {
                // This browser's session stopped with its token: reloading lands on sign-in.
                window.location.reload();
                return;
            }
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "The change did not go through.");
            setPending(null);
        } finally {
            setBusy(false);
        }
    }

    const pendingCurrent = pending !== null && tokenRow(pending.key, me, now).isCurrent;
    return (
        <section aria-label="Tokens" className="flex flex-1 flex-col">
            <div className="flex min-h-11 items-center border-b px-4 py-2">
                <span className="text-muted-foreground text-xs">
                    Operator tokens can do everything a member can. Agents use their own tokens.
                </span>
                <div className="ml-auto">
                    <MintTokenDialog onMinted={() => void load()} />
                </div>
            </div>
            {error ? (
                <p role="alert" className="text-status-down px-4 py-2 text-xs">
                    {error}
                </p>
            ) : null}
            {keys === null ? (
                <p className="text-muted-foreground p-6">Loading…</p>
            ) : keys.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-10">
                    <p className="text-muted-foreground">No tokens.</p>
                </div>
            ) : (
                <table className="w-full text-left">
                    <thead className="text-muted-foreground text-xs">
                        <tr className="border-b">
                            <th className="px-4 py-2 font-normal">Name</th>
                            <th className="px-2 py-2 font-normal">Status</th>
                            <th className="px-2 py-2 font-normal">Made by</th>
                            <th className="px-2 py-2 font-normal">Created</th>
                            <th className="px-2 py-2 font-normal">Last used</th>
                            <th className="px-2 py-2 font-normal">Expires</th>
                            <th className="w-10" />
                        </tr>
                    </thead>
                    <tbody>
                        {keys.map((key) => {
                            const row = tokenRow(key, me, now);
                            return (
                                <tr key={key.id} data-token-id={key.id} className="border-b">
                                    <td className="max-w-72 truncate px-4 py-2 font-medium">
                                        {key.name}
                                        {row.isCurrent ? (
                                            <span className="text-muted-foreground font-normal"> (this browser)</span>
                                        ) : null}
                                    </td>
                                    <td className={cn("px-2 py-2 text-xs capitalize", STATUS_CLASS[row.status])}>
                                        {row.status}
                                    </td>
                                    <td className="text-muted-foreground px-2 py-2">{row.maker}</td>
                                    <td className="text-muted-foreground px-2 py-2 tabular-nums">
                                        {day(key.createdDate)}
                                    </td>
                                    <td className="text-muted-foreground px-2 py-2 tabular-nums">{row.lastUsed}</td>
                                    <td className="text-muted-foreground px-2 py-2 tabular-nums">{row.expires}</td>
                                    <td className="px-2 py-2">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-xs"
                                                    aria-label={`Actions for ${key.name}`}
                                                >
                                                    <Ellipsis />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                {key.active ? (
                                                    <DropdownMenuItem
                                                        onSelect={() =>
                                                            row.isCurrent
                                                                ? setPending({ kind: "disable", key })
                                                                : void run(() => setTokenActive(key.id, false), false)
                                                        }
                                                    >
                                                        Disable
                                                    </DropdownMenuItem>
                                                ) : (
                                                    <DropdownMenuItem
                                                        onSelect={() =>
                                                            void run(() => setTokenActive(key.id, true), false)
                                                        }
                                                    >
                                                        Enable
                                                    </DropdownMenuItem>
                                                )}
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    variant="destructive"
                                                    onSelect={() => setPending({ kind: "delete", key })}
                                                >
                                                    Delete…
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {pending?.kind === "disable" ? "Disable" : "Delete"} {pending?.key.name}?
                        </DialogTitle>
                        <DialogDescription>
                            {pendingCurrent
                                ? "This browser signed in with it, so it signs this browser out."
                                : "Anything using it stops working at its next request."}
                            {pending?.kind === "delete" ? " Deleting cannot be undone." : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                                if (!pending) {
                                    return;
                                }
                                const { kind, key } = pending;
                                void run(
                                    () => (kind === "delete" ? deleteToken(key.id) : setTokenActive(key.id, false)),
                                    pendingCurrent
                                );
                            }}
                        >
                            {pending?.kind === "disable" ? "Disable" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
