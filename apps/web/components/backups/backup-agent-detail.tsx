"use client";

import {
    Button,
    Card,
    Checkbox,
    ConfirmDialog,
    Field,
    Input,
    PageBody,
    SectionHeader,
    Select,
    StatusDot,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@qarasky/kore-ui";
import { useCallback, useState, type FormEvent } from "react";

import { useBoardData } from "@/components/board/board-data";
import { backupStatus } from "@/components/fleet/backup-status";
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

import { NOT_LINKED, serverId, serverOptions } from "./server-options";
import { TokenDialog } from "./token-dialog";
import { VerificationDialog } from "./verification-dialog";

const RUN_TONE: Record<string, string> = { completed: "text-status-up", failed: "text-status-down" };

/** One block of the page: a heading, then its content in a Card. */
function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <section>
            <SectionHeader title={title} actions={action} className="mb-3" />
            <Card className="p-4">{children}</Card>
        </section>
    );
}

/** Name, server, enabled, schedule and retention; saved with one PATCH. */
function Settings({ agent, onSaved }: { agent: BackupAgentSummary; onSaved: (agent: BackupAgentSummary) => void }) {
    const { monitors } = useBoardData();
    const options = serverOptions(monitors);
    const [name, setName] = useState(agent.name);
    const [server, setServer] = useState(agent.monitorId === null ? NOT_LINKED : String(agent.monitorId));
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
                monitorId: serverId(server),
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
        <form onSubmit={(e) => void save(e)} className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Field label="Name" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <Field label="Server">
                <Select value={server} onValueChange={setServer} options={options} />
            </Field>
            <Field label="Expected every (seconds)">
                <Input type="number" min={60} value={interval} onChange={(e) => setIntervalSeconds(e.target.value)} />
            </Field>
            <Field label="Runs kept">
                <Input type="number" min={1} value={retention} onChange={(e) => setRetention(e.target.value)} />
            </Field>
            <Checkbox
                className="sm:col-span-2"
                checked={enabled}
                onCheckedChange={(c) => setEnabled(c === true)}
                label="Enabled"
                description="An enabled agent that misses its schedule shows as overdue."
            />
            <div className="flex items-center gap-3 sm:col-span-2">
                <Button type="submit" variant="primary" loading={busy}>
                    {busy ? "Saving…" : "Save settings"}
                </Button>
                {message ? (
                    <span role="status" className="text-meta text-muted">
                        {message}
                    </span>
                ) : null}
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
    // What the confirmation asks about; kept while it animates closed.
    const [asked, setAsked] = useState<"rotate" | "revoke">("rotate");
    const [confirming, setConfirming] = useState(false);
    function ask(kind: "rotate" | "revoke") {
        setAsked(kind);
        setConfirming(true);
    }
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
        // ConfirmDialog disables both buttons while this runs: a double-click
        // must not rotate twice and show a dead token.
        setError(null);
        try {
            if (kind === "rotate") {
                const issued = await rotateBackupToken(agent.id);
                setLocal(issued.agent);
                setToken(issued.token);
            } else {
                setLocal((await revokeBackupToken(agent.id)).agent);
            }
            setConfirming(false);
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : "That didn't work. Try again.");
            setConfirming(false);
        }
    }

    return (
        <PageBody className="grid gap-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <StatusDot status={backupStatus(health.tone)} label={health.label} />
                <span className="text-meta text-muted">
                    {agent.reportedVersion ? `Agent ${agent.reportedVersion}` : "Version not reported yet"}
                    {agent.updateStatus && agent.updateStatus !== "ok" ? ` · update: ${agent.updateStatus}` : ""}
                </span>
                <span className="text-meta text-muted">{restoreLabel(agent)}</span>
                {agent.lastErrorCode ? (
                    <span className="text-meta text-status-down">Last error: {agent.lastErrorCode}</span>
                ) : null}
            </div>
            {error ? (
                <p role="alert" className="text-meta text-danger">
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
                        <Button size="sm" onClick={() => ask("rotate")}>
                            Rotate token
                        </Button>
                        <Button
                            variant="danger-outline"
                            size="sm"
                            disabled={!agent.credentialActive}
                            onClick={() => ask("revoke")}
                        >
                            Revoke token
                        </Button>
                    </>
                }
            >
                <p>
                    {agent.credentialActive ? (
                        "The agent's token is active."
                    ) : (
                        <span className="text-status-warn">
                            The token is revoked: the agent cannot upload until it is rotated.
                        </span>
                    )}
                </p>
            </Section>
            <Section title={`Runs · ${runs.length}`}>
                {runs.length === 0 ? (
                    <p className="text-muted">No runs yet.</p>
                ) : (
                    <Table framed={false} caption="Runs" containerClassName="-mx-4 -my-4 w-auto">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Started (UTC)</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead align="right">Size</TableHead>
                                <TableHead>Took</TableHead>
                                <TableHead>Sources</TableHead>
                                <TableHead>Checked</TableHead>
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {runs.map((run) => (
                                <TableRow key={run.id} data-run-id={run.id}>
                                    <TableCell className="whitespace-nowrap tnum">
                                        {backupTime(run.exportStartedAt)}
                                    </TableCell>
                                    <TableCell className={RUN_TONE[run.status] ?? "text-muted"}>
                                        {run.status}
                                        {run.errorCode ? ` · ${run.errorCode}` : ""}
                                    </TableCell>
                                    <TableCell align="right">
                                        {formatBytes(run.totalBytes ?? run.receivedBytes)}
                                    </TableCell>
                                    <TableCell className="tnum">{backupDuration(run)}</TableCell>
                                    <TableCell muted className="text-sub">
                                        {backupSourceSummary(run)}
                                        {backupIsEncrypted(run) ? " · encrypted" : ""}
                                    </TableCell>
                                    <TableCell className="text-sub" data-verification>
                                        {verificationLabel(run)}
                                    </TableCell>
                                    <TableCell align="right" className="whitespace-nowrap">
                                        {run.status === "completed" ? (
                                            <span className="inline-flex gap-2">
                                                <Button size="sm" onClick={() => setVerifying(run)}>
                                                    Record check
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    onClick={() =>
                                                        void downloadBackupRun(run.id, backupFileName(run)).catch((e) =>
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
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
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
            <ConfirmDialog
                open={confirming}
                onOpenChange={setConfirming}
                title={asked === "revoke" ? "Revoke the token?" : "Rotate the token?"}
                description={
                    asked === "revoke"
                        ? "The agent can no longer upload until the token is rotated."
                        : "The current token stops working at once. Put the new one in the agent's token file."
                }
                confirmLabel={asked === "revoke" ? "Revoke" : "Rotate"}
                danger
                onConfirm={() => runTokenAction(asked)}
            />
        </PageBody>
    );
}
