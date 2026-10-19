import type { BackupAgentSummary, BackupRunSummary } from "@/lib/api";
import {
    backupDuration,
    backupHealth,
    backupSourceSummary,
    backupTime,
    formatBytes,
    restoreLabel,
    verificationLabel,
} from "@/lib/backup-presentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
    onDownload?: (runId: string) => void;
}) {
    if (agents.length === 0 && !error) {
        return null;
    }

    return (
        <section className="mb-4">
            <h2 className="mb-2 text-[11px] uppercase tracking-wide text-quiet">Backups</h2>
            {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
            <div className="overflow-x-auto rounded-md border border-border bg-card">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="py-2 pl-3 pr-4 font-medium">Agent</th>
                            <th className="w-24 py-2 font-medium">Health</th>
                            <th className="py-2 pr-4 font-medium">Latest completed</th>
                            <th className="w-24 py-2 font-medium">Duration</th>
                            <th className="w-24 py-2 font-medium">Bytes</th>
                            <th className="py-2 font-medium">Source</th>
                            <th className="py-2 font-medium">Verification</th>
                            <th className="w-24 py-2 pr-3 font-medium" />
                        </tr>
                    </thead>
                    <tbody>
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
                                <tr key={agent.id} className="border-b border-border/60 last:border-0">
                                    <td className="py-2 pl-3 pr-4">
                                        <div className="font-medium">{agent.name}</div>
                                        <div className="text-[11px] text-quiet">
                                            {agent.enabled ? "daily" : "disabled"} · keep {agent.retentionCount}
                                        </div>
                                        {runs?.[agent.id]?.length ? (
                                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-quiet">
                                                {runs[agent.id].slice(0, 5).map((history) => (
                                                    <span key={history.id} className="tnum">
                                                        {history.status} {backupTime(history.exportFinishedAt)}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                    </td>
                                    <td className="py-2">
                                        <Badge tone={health.tone}>
                                            <span className="size-1.5 rounded-full bg-current" />
                                            {health.label}
                                        </Badge>
                                    </td>
                                    <td className="tnum py-2 pr-4 whitespace-nowrap text-xs">
                                        {backupTime(completed?.exportFinishedAt ?? completed?.completedAt ?? null)}
                                    </td>
                                    <td className="tnum py-2 text-xs">{backupDuration(completed ?? run)}</td>
                                    <td className="tnum py-2 text-xs">
                                        {formatBytes(completed?.totalBytes ?? run?.totalBytes ?? 0)}
                                    </td>
                                    <td className="max-w-64 truncate py-2 text-xs text-quiet">
                                        {backupSourceSummary(completed ?? run)}
                                    </td>
                                    <td className="py-2 text-xs">
                                        <div>{transfer}</div>
                                        <div className="text-[11px] text-quiet">{restore}</div>
                                        {run?.errorCode ? (
                                            <div className="text-[11px] text-destructive">{run.errorCode}</div>
                                        ) : null}
                                    </td>
                                    <td className="py-2 pr-3 text-right">
                                        {completed && onDownload ? (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => onDownload(completed.id)}
                                            >
                                                Download
                                            </Button>
                                        ) : null}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
