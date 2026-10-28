import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SectionPlaceholder } from "@/components/section-placeholder";

export const metadata: Metadata = { title: "Notifications · Flatline" };

export default function NotificationsPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Notifications" }]} />
            <SectionPlaceholder title="Notifications" part={5} />
        </>
    );
}
