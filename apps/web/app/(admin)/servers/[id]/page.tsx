import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { ServerDetail } from "@/components/servers/server-detail";
import { isApiError } from "@/lib/api";
import { orNull } from "@/lib/fleet-metrics";
import { fetchLatestMetrics, fetchMonitor } from "@/lib/monitors-api";

export const metadata: Metadata = { title: "Server · Flatline" };

/** One server's page. Only push monitors are servers; anything else is not found here. */
export default async function ServerPage({ params }: { params: Promise<{ id: string }> }) {
    const { id: raw } = await params;
    const id = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) {
        notFound();
    }
    try {
        // The sample is optional: if it cannot be read, the page loads it live.
        const [{ monitor }, sample] = await Promise.all([fetchMonitor(id), orNull(fetchLatestMetrics(id))]);
        if (monitor.type !== "push") {
            notFound();
        }
        return (
            <>
                <PageHeader crumbs={[{ label: "Servers", href: "/servers" }, { label: monitor.name }]} />
                <ServerDetail initial={monitor} initialSample={sample} />
            </>
        );
    } catch (error) {
        // An id the backend cannot parse (400) or does not know (404): no such server.
        if (isApiError(error, 404) || isApiError(error, 400)) {
            notFound();
        }
        throw error;
    }
}
