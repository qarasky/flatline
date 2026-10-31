import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StatusPageApp } from "@/components/status/status-page-app";
import { readStatusPage } from "@/lib/status-server";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const outcome = await readStatusPage((await params).slug);
    return { title: outcome.kind === "ok" ? outcome.snapshot.data.config.title || "Status" : "Status" };
}

/**
 * A public status page, rendered on the server so a visitor sees it before
 * any script runs; the browser then keeps it current.
 */
export default async function StatusPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const initial = await readStatusPage(slug);
    if (initial.kind === "notfound") {
        notFound();
    }
    return <StatusPageApp slug={slug} initial={initial} renderedAt={Date.now()} />;
}
