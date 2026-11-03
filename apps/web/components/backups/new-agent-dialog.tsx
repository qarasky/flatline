"use client";

import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogFooter,
    DialogTrigger,
    Field,
    Input,
    Select,
} from "@qarasky/kore-ui";
import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useBoardData } from "@/components/board/board-data";
import { createBackupAgent } from "@/lib/backups-api";

import { NOT_LINKED, serverId, serverOptions } from "./server-options";
import { TokenDialog } from "./token-dialog";

/** Register a backup agent; its token is shown once afterwards. */
export function NewAgentDialog() {
    const { monitors, reload } = useBoardData();
    const options = serverOptions(monitors);
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [server, setServer] = useState(NOT_LINKED);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const answer = await createBackupAgent({ name: name.trim(), monitorId: serverId(server) });
            setOpen(false);
            setName("");
            setServer(NOT_LINKED);
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
                    <Button variant="primary" size="sm">
                        <Plus />
                        Register agent
                    </Button>
                </DialogTrigger>
                <DialogContent
                    title="Register a backup agent"
                    description="One agent per thing backed up, each with its own token."
                >
                    <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
                        <DialogBody className="grid gap-4">
                            <Field label="Name" required>
                                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
                            </Field>
                            <Field label="Server">
                                <Select value={server} onValueChange={setServer} options={options} />
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
