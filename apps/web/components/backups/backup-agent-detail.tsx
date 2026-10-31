"use client";

import { useCallback, useState, type FormEvent } from "react";

import { useBoardData } from "@/components/board/board-data";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
    backupDuration,
    backupFileName,
    backupHealth,
    backupIsEncrypted,
    backupSourceSummary,
    backupTime,
    formatBytes,
    restoreLabel,
    verificationLabel,
} from "@/lib/backup-presentation";
import {
    downloadBackupRun,
    fetchBackupRuns,
    revokeBackupToken,
    rotateBackupToken,
    updateBackupAgent,
} from "@/lib/backups-api";
import type { BackupAgentSummary, BackupRunSummary } from "@/lib/monitor-types";
import { cn } from "@/lib/utils";

import { TokenDialog } from "./token-dialog";
import { VerificationDialog } from "./verification-dialog";

const TONE: Record<string, string> = { up: "text-ok", down: "text-bad", degraded: "text-warn", neutral: "text-quiet" };

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <section className="border-b px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
                <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">{title}</h2>
                {action ? <div className="ml-auto flex gap-2">{action}</div> : null}
            </div>
            {children}
        </section>
    );
}

/** Name, server, enabled, schedule and retention; saved with one PATCH. */
function Settings({ agent, onSaved }: { agent: BackupAgentSummary; onSaved: (agent: BackupAgentSummary) => void }) {
    const { monitors } = useBoardData();
    const servers = monitors.filter((m) => m.type === "push");
    const [name, setName] = useState(agent.name);
    const [server, setServer] = useState(agent.monitorId === null ? "" : String(agent.monitorId));
    const [enabled, setEnabled] = useState(agent.enabled);
    const [interval, setIntervalSeconds] = useState(String(agent.intervalSeconds));
    const [retention, setRetention] = useState(String(agent.retentionCount));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    async function save(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setMessage(null);
        try {
            const answer = await updateBackupAgent(agent.id, {
                name: name.trim(),
                monitorId: server ? Number(server) : null,
                enabled,
                intervalSeconds: Number(interval),
                retentionCount: Number(retention),
            });
            onSaved(answer.agent);
            setMessage("Saved.");
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "Could not save.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={(e) => void save(e)} className="grid max-w-2xl grid-cols-2 gap-3">
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
            <div className="grid gap-1.5">
                <Label htmlFor="agent-interval">Expected every (seconds)</Label>
                <Input
                    id="agent-interval"
                    type="number"
                    min={60}
                    value={interval}
                    onChange={(e) => setIntervalSeconds(e.target.value)}
                />
            </div>
            <div className="grid gap-1.5">
                <Label htmlFor="agent-retention">Runs kept</Label>
                <Input
                    id="agent-retention"
                    type="number"
                    min={1}
                    value={retention}
                    onChange={(e) => setRetention(e.target.value)}
                />
            </div>
            <label className="col-span-2 flex items-center gap-2">
                <Checkbox checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} aria-label="Enabled" />
                Enabled: an enabled agent that misses its schedule shows as overdue.
            </label>
            <div className="col-span-2 flex items-center gap-3">
                <Button type="submit" size="sm" disabled={busy}>
                    {busy ? "Saving…" : "Save settings"}
                </Button>
                {message ? <span className="text-muted-foreground text-xs">{message}</span> : null}
            </div>
        </form>
    );
}

/**
 * One backup agent: its health, settings, runs (with downloads and recorded
 * verifications) and its token (rotate, revoke).
 */
export function BackupAgentDetail({
    initialAgent,
    initialRuns,
}: {
    initialAgent: BackupAgentSummary;
    initialRuns: BackupRunSummary[];
}) {
    const { backups, reload } = useBoardData();
    const [local, setLocal] = useState(initialAgent);
    // The live list (refreshed on backup events) wins over what this page last saw.
    const agent = backups.find((a) => a.id === initialAgent.id) ?? local;
    const [runs, setRuns] = useState(initialRuns);
    const [verifying, setVerifying] = useState<BackupRunSummary | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
    // One request per confirm: a double-click must not rotate twice and show a dead token.
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const health = backupHealth(agent);

    const refresh = useCallback(async () => {
        try {
            setRuns((await fetchBackupRuns(agent.id)).runs);
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not reload the runs.");
        }
    }, [agent.id, reload]);

    async function runTokenAction(kind: "rotate" | "revoke") {
        if (confirming) {
            return;
        }
        setConfirming(true);
        setError(null);
        try {
            if (kind === "rotate") {
                const issued = await rotateBackupToken(agent.id);
                setLocal(issued.agent);
                setToken(issued.token);
            } else {
                setLocal((await revokeBackupToken(agent.id)).agent);
            }
            setConfirm(null);
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : "That did not work.");
            setConfirm(null);
        } finally {
            setConfirming(false);
        }
    }

    return (
        <div className="flex flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
                <h1 className="text-base font-semibold">{agent.name}</h1>
                <span className={cn("text-xs font-medium", TONE[health.tone])}>{health.label}</span>
                <span className="text-muted-foreground text-xs">
                    {agent.reportedVersion ? `agent ${agent.reportedVersion}` : "version not reported yet"}
                    {agent.updateStatus && agent.updateStatus !== "ok" ? ` · update: ${agent.updateStatus}` : ""}
                </span>
                <span className="text-muted-foreground text-xs">{restoreLabel(agent)}</span>
                {agent.lastErrorCode ? (
                    <span className="text-bad text-xs">last error: {agent.lastErrorCode}</span>
                ) : null}
            </div>
            {error ? (
                <p role="alert" className="text-bad px-4 pt-3 text-xs">
                    {error}
                </p>
            ) : null}
            <Section title="Settings">
                <Settings
                    agent={agent}
                    onSaved={(saved) => {
                        setLocal(saved);
                        void reload();
                    }}
                />
            </Section>
            <Section
                title="Token"
                action={
                    <>
                        <Button variant="outline" size="xs" onClick={() => setConfirm("rotate")}>
                            Rotate token
                        </Button>
                        <Button
                            variant="outline"
                            size="xs"
                            disabled={!agent.credentialActive}
                            onClick={() => setConfirm("revoke")}
                        >
                            Revoke token
                        </Button>
                    </>
                }
            >
                <p className="text-sm">
                    {agent.credentialActive ? (
                        "The agent's token is active."
                    ) : (
                        <span className="text-warn">
                            The token is revoked: the agent cannot upload until it is rotated.
                        </span>
                    )}
                </p>
            </Section>
            <Section title={`Runs · ${runs.length}`}>
                {runs.length === 0 ? (
                    <p className="text-muted-foreground">No runs yet.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
                                    <th className="py-2 pr-3 font-medium">Started (UTC)</th>
                                    <th className="py-2 pr-3 font-medium">Status</th>
                                    <th className="py-2 pr-3 text-right font-medium">Size</th>
                                    <th className="py-2 pr-3 font-medium">Took</th>
                                    <th className="py-2 pr-3 font-medium">Sources</th>
                                    <th className="py-2 pr-3 font-medium">Checked</th>
                                    <th className="py-2 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {runs.map((run) => (
                                    <tr
                                        key={run.id}
                                        className="border-border/60 border-b last:border-0"
                                        data-run-id={run.id}
                                    >
                                        <td className="py-1.5 pr-3 whitespace-nowrap tnum">
                                            {backupTime(run.exportStartedAt)}
                                        </td>
                                        <td
                                            className={cn(
                                                "py-1.5 pr-3",
                                                run.status === "completed"
                                                    ? "text-ok"
                                                    : run.status === "failed"
                                                      ? "text-bad"
                                                      : "text-quiet"
                                            )}
                                        >
                                            {run.status}
                                            {run.errorCode ? ` · ${run.errorCode}` : ""}
                                        </td>
                                        <td className="py-1.5 pr-3 text-right tnum">
                                            {formatBytes(run.totalBytes ?? run.receivedBytes)}
                                        </td>
                                        <td className="py-1.5 pr-3 tnum">{backupDuration(run)}</td>
                                        <td className="text-muted-foreground py-1.5 pr-3 text-xs">
                                            {backupSourceSummary(run)}
                                            {backupIsEncrypted(run) ? " · encrypted" : ""}
                                        </td>
                                        <td className="py-1.5 pr-3 text-xs" data-verification>
                                            {verificationLabel(run)}
                                        </td>
                                        <td className="py-1.5 text-right whitespace-nowrap">
                                            {run.status === "completed" ? (
                                                <span className="inline-flex gap-1.5">
                                                    <Button
                                                        variant="outline"
                                                        size="xs"
                                                        onClick={() => setVerifying(run)}
                                                    >
                                                        Record check
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="xs"
                                                        onClick={() =>
                                                            void downloadBackupRun(run.id, backupFileName(run)).catch(
                                                                (e) =>
                                                                    setError(
                                                                        e instanceof Error
                                                                            ? `Download failed: ${e.message}`
                                                                            : "Download failed."
                                                                    )
                                                            )
                                                        }
                                                    >
                                                        Download
                                                    </Button>
                                                </span>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Section>
            {verifying ? (
                <VerificationDialog
                    run={verifying}
                    onClose={() => setVerifying(null)}
                    onDone={() => {
                        setVerifying(null);
                        void refresh();
                    }}
                />
            ) : null}
            {token ? <TokenDialog agentName={agent.name} token={token} onClose={() => setToken(null)} /> : null}
            <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{confirm === "rotate" ? "Rotate the token?" : "Revoke the token?"}</DialogTitle>
                        <DialogDescription>
                            {confirm === "rotate"
                                ? "The current token stops working at once. Put the new one in the agent's token file."
                                : "The agent can no longer upload until the token is rotated."}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirm(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={confirming}
                            onClick={() => confirm && void runTokenAction(confirm)}
                        >
                            {confirm === "rotate" ? "Rotate" : "Revoke"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
