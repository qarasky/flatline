"use client";

import {
    Button,
    CopyButton,
    Dialog,
    DialogBody,
    DialogContent,
    DialogFooter,
    Field,
    Input,
    Select,
} from "@qarasky/kore-ui";
import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { EXPIRY_CHOICES, expiresAt, type ExpiryChoice } from "@/lib/token-row";
import { mintToken } from "@/lib/tokens-api";

/** The minted token, shown once: only Done closes it, and closing drops it. */
function MintedToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
    return (
        <Dialog open>
            <DialogContent
                size="lg"
                title={`Token “${name}”`}
                description="Copy it now: it is shown only this once. It can do everything an operator can."
                showClose={false}
                onInteractOutside={(event) => event.preventDefault()}
                onEscapeKeyDown={(event) => event.preventDefault()}
            >
                <DialogBody>
                    <div className="flex items-center gap-2">
                        {/* The clipboard API needs a secure origin; on plain http the field is there to select. */}
                        <Input
                            readOnly
                            value={token}
                            aria-label="Operator token"
                            className="font-mono text-sub"
                            onFocus={(e) => e.target.select()}
                        />
                        <CopyButton value={token} label="Copy token" size="md" />
                    </div>
                </DialogBody>
                <DialogFooter>
                    <Button variant="primary" onClick={onDone}>
                        Done
                    </Button>
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
            setError(e instanceof Error ? e.message : "Couldn't make the token. Try again.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button
                variant="primary"
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
                <DialogContent
                    title="New operator token"
                    description="For scripts, the API and signing in without an account."
                >
                    <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
                        <DialogBody className="flex flex-col gap-4">
                            <Field label="Name" required>
                                <Input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Office wall screen"
                                    maxLength={255}
                                />
                            </Field>
                            <Field label="Expires">
                                <Select<ExpiryChoice>
                                    value={expiry}
                                    onValueChange={setExpiry}
                                    options={EXPIRY_CHOICES}
                                />
                            </Field>
                            {error ? (
                                <p role="alert" className="text-meta text-danger">
                                    {error}
                                </p>
                            ) : null}
                        </DialogBody>
                        <DialogFooter>
                            <Button onClick={() => setOpen(false)} disabled={busy}>
                                Cancel
                            </Button>
                            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
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
