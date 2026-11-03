import type { BackupAgentSummary, BackupRunSummary } from "@/lib/monitor-types";
import {
    backupDuration,
    backupHealth,
    backupSourceSummary,
    backupTime,
    formatBytes,
    restoreLabel,
    verificationLabel,
} from "@/lib/backup-presentation";
import { Button, StatusDot, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@qarasky/kore-ui";

import { backupStatus } from "./backup-status";

/**
 * Dense backup section for a monitor detail view. Each agent is independent:
 * MEKS and ZHKH rows never share health or history. The section is hidden when
 * no agent is linked, and a backup read error is shown here without hiding the
 * monitor's own details.
 */
export function BackupAgents({
    agents,
    runs,
    error,
    onDownload,
}: {
    agents: BackupAgentSummary[];
    runs?: Record<string, BackupRunSummary[]>;
    error?: string | null;
    onDownload?: (run: BackupRunSummary) => void;
}) {
    if (agents.length === 0 && !error) {
        return null;
    }

    return (
        <div className="grid gap-2">
            {error ? (
                <p role="alert" className="text-meta text-danger">
                    {error}
                </p>
            ) : null}
            {agents.length ? (
                <Table caption="Backup agents on this server">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Agent</TableHead>
                            <TableHead>Health</TableHead>
                            <TableHead>Latest completed</TableHead>
                            <TableHead>Duration</TableHead>
                            <TableHead align="right">Size</TableHead>
                            <TableHead>Source</TableHead>
                            <TableHead>Verification</TableHead>
                            <TableHead>
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {agents.map((agent) => {
                            const health = backupHealth(agent);
                            const run = agent.latestRun;
                            const completed = agent.lastCompletedRun;
                            // Transfer and restore are separate states. The
                            // agent-level restore result points at the run that
                            // was actually tested, even if a newer backup has
                            // not been restore-tested yet.
                            const transferRun = completed ?? run;
                            const transfer = transferRun ? verificationLabel(transferRun) : "Not completed";
                            const restore = restoreLabel(agent);
                            return (
                                <TableRow key={agent.id} data-agent-id={agent.id}>
                                    <TableCell>
                                        <div className="font-medium">{agent.name}</div>
                                        <div className="text-meta text-muted">
                                            {agent.enabled ? "Daily" : "Disabled"} · keep {agent.retentionCount}
                                        </div>
                                        {runs?.[agent.id]?.length ? (
                                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-muted">
                                                {runs[agent.id].slice(0, 5).map((history) => (
                                                    <span key={history.id} className="tnum">
                                                        {history.status} {backupTime(history.exportFinishedAt)}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                    </TableCell>
                                    <TableCell>
                                        <StatusDot status={backupStatus(health.tone)} label={health.label} />
                                    </TableCell>
                                    <TableCell className="tnum text-sub whitespace-nowrap">
                                        {backupTime(completed?.exportFinishedAt ?? completed?.completedAt ?? null)}
                                    </TableCell>
                                    <TableCell className="tnum text-sub">{backupDuration(completed ?? run)}</TableCell>
                                    <TableCell align="right" className="text-sub">
                                        {formatBytes(completed?.totalBytes ?? run?.totalBytes ?? 0)}
                                    </TableCell>
                                    <TableCell muted className="max-w-64 truncate text-sub">
                                        {backupSourceSummary(completed ?? run)}
                                    </TableCell>
                                    <TableCell className="text-sub">
                                        <div>{transfer}</div>
                                        <div className="text-meta text-muted">{restore}</div>
                                        {run?.errorCode ? (
                                            <div className="text-meta text-status-down">{run.errorCode}</div>
                                        ) : null}
                                    </TableCell>
                                    <TableCell align="right">
                                        {completed && onDownload ? (
                                            <Button size="sm" onClick={() => onDownload(completed)}>
                                                Download
                                            </Button>
                                        ) : null}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            ) : null}
        </div>
    );
}
