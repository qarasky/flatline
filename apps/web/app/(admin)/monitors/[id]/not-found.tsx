import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function MonitorNotFound() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Monitors", href: "/monitors" }, { label: "Not found" }]} />
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
                <p className="font-medium">No monitor with that id</p>
                <p className="text-muted-foreground text-xs">It may have been deleted, or the link is wrong.</p>
                <Button variant="outline" size="sm" asChild>
                    <Link href="/monitors">Back to Monitors</Link>
                </Button>
            </div>
        </>
    );
}
