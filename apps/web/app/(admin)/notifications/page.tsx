import type { Metadata } from "next";

import { NotificationsList } from "@/components/notifications/notifications-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Notifications · Flatline" };

export default function NotificationsPage() {
    return (
        <>
            <PageHeader crumbs={[{ label: "Notifications" }]} />
            <NotificationsList />
        </>
    );
}
