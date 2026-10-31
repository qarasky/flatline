import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MonitorDetail } from "@/components/monitors/monitor-detail";
import { PageHeader } from "@/components/page-header";
import { isApiError } from "@/lib/api";
import { monitorCrumbs } from "@/lib/monitor-crumbs";
import { BEAT_LIMIT, fetchAllMonitors, fetchHeartbeats, fetchMonitor } from "@/lib/monitors-api";

export const metadata: Metadata = { title: "Monitor · Flatline" };

/** A monitor's own page: the same detail as the peek panel, with its groups as breadcrumbs. */
export default async function MonitorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id: raw } = await params;
    const id = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) {
        notFound();
    }
    try {
        const [{ monitor }, log, roster] = await Promise.all([
            fetchMonitor(id),
            fetchHeartbeats(id, BEAT_LIMIT),
            fetchAllMonitors(),
        ]);
        return (
            <>
                <PageHeader crumbs={monitorCrumbs(roster, id)} />
                <MonitorDetail id={id} initial={{ monitor, beats: log.heartbeats, total: log.total }} />
            </>
        );
    } catch (error) {
        // 400: an id the backend cannot even parse; either way, no such monitor.
        if (isApiError(error, 404) || isApiError(error, 400)) {
            notFound();
        }
        throw error;
    }
}
