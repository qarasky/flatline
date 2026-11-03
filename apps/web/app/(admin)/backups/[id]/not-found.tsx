import { Button, EmptyState, PageBody, PageHeader } from "@qarasky/kore-ui";
import { Archive } from "lucide-react";
import Link from "next/link";

export default function BackupAgentNotFound() {
    return (
        <>
            <PageHeader breadcrumbs={[{ label: "Backups", href: "/backups" }]} title="Not found" />
            <PageBody>
                <EmptyState
                    icon={<Archive />}
                    title="No backup agent with that id"
                    description="It may have been removed, or the link is wrong."
                    action={
                        <Button asChild>
                            <Link href="/backups">Back to Backups</Link>
                        </Button>
                    }
                />
            </PageBody>
        </>
    );
}
