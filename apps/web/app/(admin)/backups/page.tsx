import type { Metadata } from "next";

import { BackupsList } from "@/components/backups/backups-list";
import { NewAgentDialog } from "@/components/backups/new-agent-dialog";
import { PageHeader } from "@qarasky/kore-ui";

export const metadata: Metadata = { title: "Backups · Flatline" };

export default function BackupsPage() {
    return (
        <>
            <PageHeader title="Backups" actions={<NewAgentDialog />} />
            <BackupsList />
        </>
    );
}
