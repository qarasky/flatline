import type { Metadata } from "next";
import { Suspense } from "react";

import { MonitorsBoard } from "@/components/monitors/monitors-board";
import { NewMonitorButton } from "@/components/monitors/new-monitor-dialog";
import { PauseButton } from "@/components/monitors/pause-button";
import { PageHeader } from "@qarasky/kore-ui";
import { parseBoardQuery } from "@/lib/board-url";
import { toSearchString } from "@/lib/search-string";

export const metadata: Metadata = { title: "Monitors · KoreMonitor" };

export default async function MonitorsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    // Filters, sort and the open monitor come from the URL, so the server
    // renders the board as linked.
    const initialQuery = parseBoardQuery(toSearchString(await searchParams));
    return (
        <>
            <PageHeader
                title="Monitors"
                actions={
                    <>
                        <PauseButton />
                        <NewMonitorButton />
                    </>
                }
            />
            <Suspense>
                <MonitorsBoard initialQuery={initialQuery} />
            </Suspense>
        </>
    );
}
