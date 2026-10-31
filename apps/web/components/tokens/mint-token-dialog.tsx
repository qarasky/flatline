"use client";

import { Copy, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { EXPIRY_CHOICES, expiresAt, type ExpiryChoice } from "@/lib/token-row";
import { mintToken } from "@/lib/tokens-api";

/** The minted token, shown once: only Done closes it, and closing drops it. */
function MintedToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
    const [copied, setCopied] = useState(false);
    return (
        <Dialog open>
            <DialogContent
                className="sm:max-w-lg"
                showCloseButton={false}
                onInteractOutside={(event) => event.preventDefault()}
                onEscapeKeyDown={(event) => event.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle>Token {name}</DialogTitle>
                    <DialogDescription>
                        Copy it now: it is shown only this once. It can do everything an operator can.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex gap-2">
                    <Input
                        readOnly
                        value={token}
                        aria-label="Operator token"
                        className="font-mono text-xs"
                        onFocus={(e) => e.target.select()}
                    />
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label="Copy token"
                        onClick={() => {
                            // The clipboard API needs a secure origin; on plain http the field is there to select.
                            if (!navigator.clipboard) {
                                return;
                            }
                            void navigator.clipboard.writeText(token).then(() => setCopied(true));
                        }}
                    >
                        <Copy />
                    </Button>
                </div>
                {copied ? <p className="text-muted-foreground text-xs">Copied.</p> : null}
                <DialogFooter>
                    <Button onClick={onDone}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Mint an operator token with a name and an optional expiry. */
export function MintTokenDialog({ onMinted }: { onMinted: () => void }) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [expiry, setExpiry] = useState<ExpiryChoice>("never");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const answer = await mintToken({ name: name.trim(), expires: expiresAt(expiry, Date.now()) });
            setOpen(false);
            setName("");
            setExpiry("never");
            setMinted({ name: answer.apiKey.name, token: answer.token });
            onMinted();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not make the token.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button
                size="sm"
                onClick={() => {
                    setName("");
                    setExpiry("never");
                    setError(null);
                    setOpen(true);
                }}
            >
                <Plus />
                New token
            </Button>
            <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
                <DialogContent className="sm:max-w-md">
                    <form onSubmit={(e) => void submit(e)} className="grid gap-4">
                        <DialogHeader>
                            <DialogTitle>New operator token</DialogTitle>
                            <DialogDescription>
                                For scripts, the API and signing in without an account.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-1.5">
                            <Label htmlFor="token-name">Name</Label>
                            <Input
                                id="token-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="What uses it"
                                required
                                maxLength={255}
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="token-expiry">Expires</Label>
                            <NativeSelect
                                id="token-expiry"
                                value={expiry}
                                onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}
                            >
                                {EXPIRY_CHOICES.map((choice) => (
                                    <NativeSelectOption key={choice.value} value={choice.value}>
                                        {choice.label}
                                    </NativeSelectOption>
                                ))}
                            </NativeSelect>
                        </div>
                        {error ? (
                            <p role="alert" className="text-status-down text-xs">
                                {error}
                            </p>
                        ) : null}
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy || !name.trim()}>
                                {busy ? "Making…" : "Make token"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            {minted ? <MintedToken name={minted.name} token={minted.token} onDone={() => setMinted(null)} /> : null}
        </>
    );
}
