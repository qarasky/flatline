import { PageBody, PageHeader } from "@qarasky/kore-ui";
import type { Metadata } from "next";

import { NotificationsList } from "@/components/notifications/notifications-list";

export const metadata: Metadata = { title: "Notifications · Flatline" };

export default function NotificationsPage() {
    return (
        <>
            <PageHeader title="Notifications" />
            <PageBody>
                <NotificationsList />
            </PageBody>
        </>
    );
}
