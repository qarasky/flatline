"use client";

import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useBoardData } from "@/components/board/board-data";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { createBackupAgent } from "@/lib/backups-api";

import { TokenDialog } from "./token-dialog";

/** Register a backup agent; its token is shown once afterwards. */
export function NewAgentDialog() {
    const { monitors, reload } = useBoardData();
    const servers = monitors.filter((m) => m.type === "push");
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [server, setServer] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const answer = await createBackupAgent({ name: name.trim(), monitorId: server ? Number(server) : null });
            setOpen(false);
            setName("");
            setServer("");
            setIssued({ name: answer.agent.name, token: answer.token });
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not register the agent.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                    <Button size="sm">
                        <Plus />
                        Register agent
                    </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                    <form onSubmit={(e) => void submit(e)} className="grid gap-4">
                        <DialogHeader>
                            <DialogTitle>Register a backup agent</DialogTitle>
                            <DialogDescription>
                                One agent per thing backed up, each with its own token.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-1.5">
                            <Label htmlFor="agent-name">Name</Label>
                            <Input
                                id="agent-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                maxLength={100}
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="agent-server">Server</Label>
                            <NativeSelect
                                id="agent-server"
                                className="w-full"
                                value={server}
                                onChange={(e) => setServer(e.target.value)}
                            >
                                <NativeSelectOption value="">— not linked</NativeSelectOption>
                                {servers.map((s) => (
                                    <NativeSelectOption key={s.id} value={String(s.id)}>
                                        {s.name}
                                    </NativeSelectOption>
                                ))}
                            </NativeSelect>
                        </div>
                        {error ? (
                            <p role="alert" className="text-bad text-xs">
                                {error}
                            </p>
                        ) : null}
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy || !name.trim()}>
                                {busy ? "Registering…" : "Register"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            {issued ? (
                <TokenDialog agentName={issued.name} token={issued.token} onClose={() => setIssued(null)} />
            ) : null}
        </>
    );
}
