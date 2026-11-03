import { Button, EmptyState, PageBody, PageHeader } from "@qarasky/kore-ui";
import { Server } from "lucide-react";
import Link from "next/link";

export default function ServerNotFound() {
    return (
        <>
            <PageHeader breadcrumbs={[{ label: "Servers", href: "/servers" }]} title="Not found" />
            <PageBody>
                <EmptyState
                    icon={<Server />}
                    title="No server with that id"
                    description="A server is a push monitor whose host runs the agent. The id may be wrong, or it was deleted."
                    action={
                        <Button asChild>
                            <Link href="/servers">Back to Servers</Link>
                        </Button>
                    }
                />
            </PageBody>
        </>
    );
}
