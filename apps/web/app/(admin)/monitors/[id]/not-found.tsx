import { Button, EmptyState, PageBody, PageHeader } from "@qarasky/kore-ui";
import { Activity } from "lucide-react";
import Link from "next/link";

export default function MonitorNotFound() {
    return (
        <>
            <PageHeader breadcrumbs={[{ label: "Monitors", href: "/monitors" }]} title="Not found" />
            <PageBody>
                <EmptyState
                    icon={<Activity />}
                    title="No monitor with that id"
                    description="It may have been deleted, or the link is wrong."
                    action={
                        <Button asChild>
                            <Link href="/monitors">Back to Monitors</Link>
                        </Button>
                    }
                />
            </PageBody>
        </>
    );
}
