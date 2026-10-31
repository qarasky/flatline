/** Notification configs (Telegram) for the Notifications section. */

import { api } from "@/lib/api";

/** A notification as the list returns it: the bot token is never included. */
export interface NotificationRecord {
    id: number;
    name: string;
    type: string;
    active: boolean;
    isDefault: boolean;
    config: Record<string, unknown>;
    /** Monitors that alert through it. */
    monitorIds: number[];
}

export async function fetchNotificationList(): Promise<NotificationRecord[]> {
    const body = await api<{ notifications: NotificationRecord[] }>("/api/v1/notifications");
    return body.notifications.map((n) => ({ ...n, monitorIds: n.monitorIds ?? [] }));
}

type Body = { name: string; type: string; active: boolean; isDefault: boolean; config: Record<string, unknown> };

export function createNotification(body: Body): Promise<{ ok: true; id: number }> {
    return api("/api/v1/notifications", { method: "POST", body });
}

export function updateNotification(id: number, body: Body): Promise<{ ok: true; id: number }> {
    return api(`/api/v1/notifications/${id}`, { method: "PATCH", body });
}

export function deleteNotification(id: number): Promise<{ ok: true; deleted: number }> {
    return api(`/api/v1/notifications/${id}`, { method: "DELETE" });
}
