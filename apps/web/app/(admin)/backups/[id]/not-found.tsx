import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function BackupAgentNotFound() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Backups", href: "/backups" }, { label: "Not found" }]} />
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
                <p className="font-medium">No backup agent with that id</p>
                <Button variant="outline" size="sm" asChild>
                    <Link href="/backups">Back to Backups</Link>
                </Button>
            </div>
        </>
    );
}
