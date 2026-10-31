import type { Metadata } from "next";

import { BackupsList } from "@/components/backups/backups-list";
import { NewAgentDialog } from "@/components/backups/new-agent-dialog";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Backups · Flatline" };

export default function BackupsPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Backups" }]} actions={<NewAgentDialog />} />
            <BackupsList />
        </>
    );
}
