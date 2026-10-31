import type { Metadata } from "next";
import { Suspense } from "react";

import { MonitorsBoard } from "@/components/monitors/monitors-board";
import { PauseButton } from "@/components/monitors/pause-button";
import { PageHeader } from "@/components/page-header";
import { parseBoardQuery } from "@/lib/board-url";

export const metadata: Metadata = { title: "Monitors · Flatline" };

export default function MonitorsPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Monitors" }]} actions={<PauseButton />} />
            <Suspense>
                <MonitorsBoard initialQuery={parseBoardQuery("")} />
            </Suspense>
        </>
    );
}
