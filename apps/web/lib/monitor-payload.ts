import { ALERT_THRESHOLD_FIELDS } from "@/lib/monitor-schema";

/**
 * The body the monitor form sends on create (POST) or edit (PATCH).
 *
 * - Empty strings and undefined are dropped, so a PATCH stays partial.
 * - Alert thresholds are always sent, null when empty: an empty field means
 *   "disable this alert", and omitting it would keep the old value.
 * - The provider clears the same way, trimmed and lowercased.
 * - `notificationIDList` (exactly these notifications) is sent only when the
 *   form loaded the list: a failed read must not unlink everything.
 * - `notificationIds` is what the monitor read returns; it is never sent back.
 */
export function buildMonitorPayload(
    type: string,
    values: Record<string, unknown>,
    notifications?: number[]
): Record<string, unknown> {
    const payload: Record<string, unknown> = { type };
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined || value === "" || key === "notificationIds") {
            continue;
        }
        payload[key] = value;
    }
    for (const field of ALERT_THRESHOLD_FIELDS) {
        payload[field.key] = values[field.key] ?? null;
    }
    payload.provider =
        typeof values.provider === "string" && values.provider.trim() !== ""
            ? values.provider.trim().toLowerCase()
            : null;
    if (notifications) {
        payload.notificationIDList = notifications;
    }
    return payload;
}

/**
 * The notifications a save sends: the ticked ones once the list loaded,
 * nothing otherwise. Never for a group: its form shows no picker, so
 * sending the defaults would add alerts nobody chose.
 */
export function notificationsToSend(type: string, loaded: boolean, chosen: Set<number>): number[] | undefined {
    return loaded && type !== "group" ? [...chosen] : undefined;
}
