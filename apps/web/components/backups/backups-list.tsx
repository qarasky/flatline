"use client";

import {
    EmptyState,
    PageBody,
    StatusDot,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    TableRowHeader,
} from "@qarasky/kore-ui";
import { Archive } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useBoardData } from "@/components/board/board-data";
import { backupStatus } from "@/components/fleet/backup-status";
import { backupHealth, backupIsEncrypted, backupTime } from "@/lib/backup-presentation";
import { ageOf } from "@/lib/fleet-presentation";
import type { BackupAgentSummary } from "@/lib/monitor-types";

function Row({ agent, serverName, now }: { agent: BackupAgentSummary; serverName: string | null; now: number }) {
    const router = useRouter();
    const health = backupHealth(agent);
    const last = agent.lastCompletedRun;
    const href = `/backups/${agent.id}`;
    return (
        <TableRow
            interactive
            data-agent-id={agent.id}
            onClick={(event) => {
                // The name is the real link; the rest of the row is a mouse shortcut to it.
                if (!(event.target as HTMLElement).closest("a")) {
                    router.push(href);
                }
            }}
        >
            <TableRowHeader className="max-w-64">
                <Link href={href} className="block truncate font-medium hover:underline">
                    {agent.name}
                </Link>
            </TableRowHeader>
            <TableCell>
                <StatusDot status={backupStatus(health.tone)} label={health.label} />
            </TableCell>
            <TableCell muted className="max-w-48 truncate">
                {serverName ?? "Not linked"}
            </TableCell>
            <TableCell muted className="tnum text-sub">
                {last
                    ? `${backupTime(last.completedAt)} · ${ageOf(last.completedAt, now)} ago`
                    : "No completed run yet"}
            </TableCell>
            <TableCell muted className="tnum text-sub">
                {agent.reportedVersion ?? "—"}
            </TableCell>
            <TableCell muted className="text-sub">
                {last ? (backupIsEncrypted(last) ? "Encrypted" : "Plain") : "—"}
            </TableCell>
        </TableRow>
    );
}

/** Every backup agent, with its health, server, last completed run, version and encryption. */
export function BackupsList() {
    const { backups, monitors, rosterLoaded, now } = useBoardData();
    if (!rosterLoaded) {
        return (
            <PageBody>
                <p className="text-muted">Loading…</p>
            </PageBody>
        );
    }
    const names = new Map(monitors.map((m) => [m.id, m.name]));
    return (
        <PageBody>
            {backups.length === 0 ? (
                <EmptyState
                    icon={<Archive />}
                    title="No backup agents yet"
                    description="Register one, then install the backup agent on the host with its token."
                />
            ) : (
                <Table caption="Backup agents" aria-label="Backup agents">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Agent</TableHead>
                            <TableHead>Health</TableHead>
                            <TableHead>Server</TableHead>
                            <TableHead>Last completed</TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead>Encryption</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {[...backups]
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((agent) => (
                                <Row
                                    key={agent.id}
                                    agent={agent}
                                    serverName={
                                        agent.monitorId !== null
                                            ? (names.get(agent.monitorId) ?? `#${agent.monitorId}`)
                                            : null
                                    }
                                    now={now}
                                />
                            ))}
                    </TableBody>
                </Table>
            )}
        </PageBody>
    );
}
