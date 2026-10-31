import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BackupAgentDetail } from "@/components/backups/backup-agent-detail";
import { PageHeader } from "@/components/page-header";
import { fetchBackupRuns } from "@/lib/backups-api";
import { fetchAllBackupAgents } from "@/lib/monitors-api";

export const metadata: Metadata = { title: "Backup agent · Flatline" };

/** One backup agent. The API has no single-agent read, so the page finds it in the full list. */
export default async function BackupAgentPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const agent = (await fetchAllBackupAgents()).find((a) => a.id === id);
    if (!agent) {
        notFound();
    }
    const { runs } = await fetchBackupRuns(agent.id);
    return (
        <>
            <PageHeader crumbs={[{ label: "Backups", href: "/backups" }, { label: agent.name }]} />
            <BackupAgentDetail initialAgent={agent} initialRuns={runs} />
        </>
    );
}
