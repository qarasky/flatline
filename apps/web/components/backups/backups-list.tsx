"use client";

import Link from "next/link";

import { useBoardData } from "@/components/board/board-data";
import { backupHealth, backupIsEncrypted, backupTime } from "@/lib/backup-presentation";
import { ageOf } from "@/lib/fleet-presentation";
import type { BackupAgentSummary } from "@/lib/monitor-types";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = { up: "text-ok", down: "text-bad", degraded: "text-warn", neutral: "text-quiet" };

function Row({ agent, serverName, now }: { agent: BackupAgentSummary; serverName: string | null; now: number }) {
    const health = backupHealth(agent);
    const last = agent.lastCompletedRun;
    return (
        <li>
            <Link
                href={`/backups/${agent.id}`}
                data-agent-id={agent.id}
                className="hover:bg-accent grid grid-cols-[minmax(0,1.2fr)_100px_minmax(0,1fr)_minmax(0,1.2fr)_90px_90px] items-center gap-4 border-b px-4 py-2.5"
            >
                <span className="truncate font-medium">{agent.name}</span>
                <span className={cn("text-xs font-medium", TONE[health.tone])}>{health.label}</span>
                <span className="text-muted-foreground truncate text-xs">{serverName ?? "not linked"}</span>
                <span className="text-muted-foreground truncate text-xs tnum">
                    {last
                        ? `last ${backupTime(last.completedAt)} · ${ageOf(last.completedAt, now)} ago`
                        : "no completed run yet"}
                </span>
                <span className="text-muted-foreground text-xs tnum">{agent.reportedVersion ?? "—"}</span>
                <span className="text-muted-foreground text-xs">
                    {last ? (backupIsEncrypted(last) ? "encrypted" : "plain") : "—"}
                </span>
            </Link>
        </li>
    );
}

/** Every backup agent, with its health, server, last completed run, version and encryption. */
export function BackupsList() {
    const { backups, monitors, rosterLoaded, now } = useBoardData();
    if (!rosterLoaded) {
        return <p className="text-muted-foreground p-6">Loading…</p>;
    }
    const names = new Map(monitors.map((m) => [m.id, m.name]));
    return backups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-10">
            <p className="text-muted-foreground max-w-sm text-center">
                No backup agents yet. Register one, then install the backup agent on the host with its token.
            </p>
        </div>
    ) : (
        <ul aria-label="Backup agents">
            {[...backups]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((agent) => (
                    <Row
                        key={agent.id}
                        agent={agent}
                        serverName={
                            agent.monitorId !== null ? (names.get(agent.monitorId) ?? `#${agent.monitorId}`) : null
                        }
                        now={now}
                    />
                ))}
        </ul>
    );
}
