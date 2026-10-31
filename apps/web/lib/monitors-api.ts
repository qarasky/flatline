/**
 * Monitor, metrics, link and backup calls, ported from the old dashboard's
 * `api.ts` onto {@link api}, so each works from a server component (with the
 * session cookie forwarded) and in the browser.
 */

import { api, isApiError } from "@/lib/api";
import type { HeartbeatEntry } from "@/lib/heartbeat-log";
import type {
    BackupAgentSummary,
    CPUPeak,
    MetricsHistorySummary,
    MetricsPayload,
    MonitorLinks,
    MonitorMute,
    MonitorSummary,
    MonitorTypeInfo,
    NotificationSummary,
    Pagination,
} from "@/lib/monitor-types";

/** One page of monitors; `status` and `q` filter server-side. */
export function fetchMonitors(
    params: { status?: string; q?: string; page?: number; perPage?: number } = {},
    signal?: AbortSignal
): Promise<{ ok: true; count: number; monitors: MonitorSummary[]; pagination: Pagination }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            query.set(key, String(value));
        }
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return api(`/api/v1/monitors${suffix}`, { signal });
}

/** Every monitor: roster snapshots never silently truncate a larger fleet. */
export async function fetchAllMonitors(signal?: AbortSignal): Promise<MonitorSummary[]> {
    const monitors: MonitorSummary[] = [];
    for (let page = 1; ; page++) {
        const result = await fetchMonitors({ page, perPage: 200 }, signal);
        monitors.push(...result.monitors);
        if (!result.pagination.hasMore) {
            return monitors;
        }
    }
}

/** One monitor's full record (with `notificationIds`). */
export function fetchMonitor(
    id: number,
    signal?: AbortSignal
): Promise<{ ok: true; monitor: MonitorSummary & Record<string, unknown> }> {
    return api(`/api/v1/monitors/${id}`, { signal });
}

/** Rows kept in a monitor's recent-checks list. */
export const BEAT_LIMIT = 120;

/** Recent heartbeats, newest first, plus the total. */
export async function fetchHeartbeats(
    id: number,
    limit = 120,
    signal?: AbortSignal
): Promise<{ heartbeats: HeartbeatEntry[]; total: number }> {
    const body = await api<{ heartbeats?: HeartbeatEntry[]; total?: number }>(
        `/api/v1/monitors/${id}/heartbeats?limit=${limit}`,
        { signal }
    );
    return { heartbeats: body.heartbeats ?? [], total: body.total ?? 0 };
}

export function fetchMonitorTypes(): Promise<{ ok: true; types: Record<string, MonitorTypeInfo> }> {
    return api("/api/v1/monitor-types");
}

/** Create a monitor; fields the backend does not know come back in `ignoredFields`. */
export function createMonitor(
    payload: Record<string, unknown>
): Promise<{ ok: true; monitor: MonitorSummary; ignoredFields: string[] }> {
    return api("/api/v1/monitors", { method: "POST", body: payload });
}

/** Partially update a monitor: only the supplied fields change. */
export function updateMonitor(
    id: number,
    payload: Record<string, unknown>
): Promise<{ ok: true; monitor: MonitorSummary; ignoredFields: string[] }> {
    return api(`/api/v1/monitors/${id}`, { method: "PATCH", body: payload });
}

/** Delete a monitor, or a group with everything under it. */
export function deleteMonitor(
    id: number,
    deleteChildren = false
): Promise<{ ok: true; deleted: number[]; count: number }> {
    const suffix = deleteChildren ? "?deleteChildren=true" : "";
    return api(`/api/v1/monitors/${id}${suffix}`, { method: "DELETE" });
}

/** Pause a monitor: checks stop until it is resumed. */
export function pauseMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary }> {
    return api(`/api/v1/monitors/${id}`, { method: "PATCH", body: { active: false } });
}

export function resumeMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary }> {
    return api(`/api/v1/monitors/${id}`, { method: "PATCH", body: { active: true } });
}

/** Mute a known outage on a monitor (and the websites linked to it). 400 when nothing is down. */
export function muteMonitor(id: number): Promise<{ ok: true; id: number; mute: MonitorMute }> {
    return api(`/api/v1/monitors/${id}/mute`, { method: "POST" });
}

/** Unmute a monitor: its own mute and every mute covering it. */
export function unmuteMonitor(id: number): Promise<{ ok: true; id: number; unmuted: number[] }> {
    return api(`/api/v1/monitors/${id}/mute`, { method: "DELETE" });
}

/** Acknowledge every agent warning counter at once. */
export function clearAgentWarnings(id: number): Promise<{ ok: true; id: number }> {
    return api(`/api/v1/monitors/${id}/agent-warnings/clear`, { method: "POST" });
}

/**
 * 24 h strips for at most 200 monitors (callers chunk). Callers treat any
 * failure as "no strips".
 */
export function fetchHeartbeatStrips(
    ids: number[],
    options: { hours?: number; buckets?: number } = {},
    signal?: AbortSignal
): Promise<{
    ok: true;
    hours: number;
    buckets: number;
    bucketSeconds: number;
    start: string;
    strips: Record<string, ([number, number, number] | null)[]>;
}> {
    const query = new URLSearchParams({
        ids: ids.join(","),
        hours: String(options.hours ?? 24),
        buckets: String(options.buckets ?? 48),
    });
    return api(`/api/v1/monitors/heartbeat-strips?${query.toString()}`, { signal });
}

/** The latest metrics sample of at most 200 push monitors. */
export function fetchLatestMetricsBulk(
    ids: number[],
    signal?: AbortSignal
): Promise<{
    ok: true;
    count: number;
    samples: Record<number, { time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null } | null>;
}> {
    return api(`/api/v1/monitors/metrics/latest?ids=${ids.join(",")}`, { signal });
}

/** Every backup agent, all pages: one listing for the whole board. */
export async function fetchAllBackupAgents(signal?: AbortSignal): Promise<BackupAgentSummary[]> {
    const agents: BackupAgentSummary[] = [];
    let cursor: string | null = null;
    // Bounded: a cursor loop that never ends must not hang the board.
    for (let page = 0; page < 100; page++) {
        const query: string = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
        const body: { agents: BackupAgentSummary[]; nextCursor: string | null } = await api(
            `/api/v1/backup-agents${query}`,
            { signal }
        );
        agents.push(...body.agents);
        cursor = body.nextCursor;
        if (!cursor) {
            break;
        }
    }
    return agents;
}

/** One server's linked websites, raw and resolved. */
export function fetchMonitorLinks(
    id: number,
    signal?: AbortSignal
): Promise<{ ok: true; monitorId: number } & MonitorLinks> {
    return api(`/api/v1/monitors/${id}/links`, { signal });
}

/** Linked websites for many servers at once (the Superboard); servers without links are absent. */
export function fetchBulkMonitorLinks(
    ids: number[],
    signal?: AbortSignal
): Promise<{ ok: true; count: number; servers: Record<string, MonitorLinks> }> {
    return api(`/api/v1/monitors/links?ids=${ids.join(",")}`, { signal });
}

/** Replace a server's linked websites with exactly these ids. */
export function replaceMonitorLinks(
    id: number,
    linkedMonitorIds: number[]
): Promise<{ ok: true; monitorId: number } & MonitorLinks> {
    return api(`/api/v1/monitors/${id}/links`, { method: "PUT", body: { linkedMonitorIds } });
}

/** Notification configs, trimmed to what the monitor form shows. */
export async function fetchNotifications(): Promise<NotificationSummary[]> {
    const body = await api<{ notifications: NotificationSummary[] }>("/api/v1/notifications");
    return body.notifications.map(({ id, name, type, active, isDefault }) => ({ id, name, type, active, isDefault }));
}

/** A server's history charts and percentiles over the last `hours`. */
export function fetchMetricsHistory(id: number, hours: number, signal?: AbortSignal): Promise<MetricsHistorySummary> {
    return api(`/api/v1/monitors/${id}/metrics/summary?hours=${hours}`, { signal });
}

/** A server's latest metrics sample, or null when it has sent none yet. */
export async function fetchLatestMetrics(
    id: number,
    signal?: AbortSignal
): Promise<{ time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null } | null> {
    try {
        return await api(`/api/v1/monitors/${id}/metrics/latest`, { signal });
    } catch (error) {
        if (isApiError(error, 404)) {
            return null;
        }
        throw error;
    }
}
