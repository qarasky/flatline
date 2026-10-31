import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function ServerNotFound() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Servers", href: "/servers" }, { label: "Not found" }]} />
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
                <p className="font-medium">No server with that id</p>
                <p className="text-muted-foreground text-xs">
                    A server is a push monitor whose host runs the agent. The id may be wrong or deleted.
                </p>
                <Button variant="outline" size="sm" asChild>
                    <Link href="/servers">Back to Servers</Link>
                </Button>
            </div>
        </>
    );
}
