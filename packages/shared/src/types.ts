/**
 * Shapes returned by the Flatline status page API.
 *
 * These mirror what server/model/status_page.js puts in
 * `StatusPage.getStatusPageData()` and what
 * server/routers/status-page-router.js serves from its `/api/status-page/*`
 * routes. Kept hand-written rather than generated so both apps can depend on
 * them without a codegen step.
 */

/** Monitor state codes used throughout Uptime Kuma. */
export const MonitorState = {
    UP: 1,
    DOWN: 0,
    PENDING: 2,
    MAINTENANCE: 3,
} as const;

export type MonitorStateValue = (typeof MonitorState)[keyof typeof MonitorState];

/**
 * Map a numeric status onto the words shown on a status page.
 *
 * Status is never communicated by colour alone: the colour can be wrong for a
 * colourblind reader, and a single blip should not look like an outage.
 * @param state Numeric status from the API
 * @returns Short label, e.g. "Operational"
 */
export function stateLabel(state: number | null | undefined): string {
    switch (state) {
        case MonitorState.UP:
            return "Operational";
        case MonitorState.DOWN:
            return "Down";
        case MonitorState.MAINTENANCE:
            return "Under maintenance";
        case MonitorState.PENDING:
            return "Pending";
        default:
            return "Unknown";
    }
}

/**
 * Severity bucket for a monitor or a page.
 * @param state Numeric status from the API
 * @returns One of the four severity keys
 */
export function stateSeverity(
    state: number | null | undefined
): "up" | "degraded" | "down" | "maintenance" | "unknown" {
    switch (state) {
        case MonitorState.UP:
            return "up";
        case MonitorState.DOWN:
            return "down";
        case MonitorState.MAINTENANCE:
            return "maintenance";
        case MonitorState.PENDING:
            return "degraded";
        default:
            return "unknown";
    }
}

export interface StatusPageConfig {
    slug: string;
    title: string;
    description: string | null;
    icon: string | null;
    accentColor?: string | null;
    autoRefreshInterval: number | null;
    theme: string;
    published: boolean;
    showTags: boolean;
    customCSS: string | null;
    footerText: string | null;
    showPoweredBy: boolean;
    analyticsId?: string | null;
    analyticsType?: string | null;
    showCertificateExpiry?: boolean | null;
    showOnlyLastHeartbeat?: boolean | null;
}

export interface Incident {
    id: number;
    style: string;
    title: string;
    content: string;
    pin: boolean;
    active: boolean;
    createdDate: string;
    lastUpdatedDate: string | null;
    statusPageId?: number;
}

export interface MaintenanceWindow {
    id: number;
    title: string;
    description: string;
    startDate: string;
    endDate: string;
    active?: boolean;
    strategy?: string;
    weekdays?: string | null;
    intervalDay?: number | null;
}

/**
 * A single heartbeat as returned by /api/status-page/heartbeat/:slug.
 *
 * These are objects, not bare status codes, and they arrive keyed by monitor
 * id rather than nested inside the monitor.
 */
export interface Heartbeat {
    status: number;
    time: string;
    msg: string;
    ping: number | null;
}

export interface MonitorEntry {
    id: number;
    name: string;
    type: string;
    sendUrl: number | string;
    /** Present only when the page has showTags enabled. */
    tags?: { id: number; name: string; color: string }[];
    certInfo?: { daysRemaining?: number; valid?: boolean } | null;
    domainInfo?: { daysRemaining?: number; expiry?: string } | null;
}

/** A monitor paired with the live state derived from its beats. */
export interface MonitorStateEntry {
    monitor: MonitorEntry;
    state: {
        status: number;
        ping: number | null;
        msg: string;
        beats: Heartbeat[];
    };
}

export interface MonitorGroup {
    id: number;
    name: string;
    weight: number;
    /** The status page group table exposes monitors as `monitorList`. */
    monitorList: MonitorEntry[];
}

export interface StatusPageData {
    config: StatusPageConfig;
    incidents: Incident[];
    publicGroupList: MonitorGroup[];
    maintenanceList: MaintenanceWindow[];
}

/** Shape returned when a page is password protected and not yet unlocked. */
export interface PasswordRequired {
    ok: false;
    error: "password_required";
    message: string;
}

/**
 * Reduce a page's monitors to one overall severity.
 *
 * Maintenance wins over everything because it is deliberate, not a failure.
 * @param groups Monitor groups on the page
 * @returns The worst severity present
 */
export function pageSeverity(entries: MonitorStateEntry[]): ReturnType<typeof stateSeverity> {
    const order = ["unknown", "up", "degraded", "maintenance", "down"] as const;

    let worst: ReturnType<typeof stateSeverity> = "up";
    let seen = false;

    for (const entry of entries) {
        seen = true;
        const severity = stateSeverity(entry.state.status);
        if (order.indexOf(severity) > order.indexOf(worst)) {
            worst = severity;
        }
    }

    return seen ? worst : "unknown";
}

/**
 * Pair each monitor on the page with its live state.
 *
 * The config endpoint does not carry status; it only arrives with the
 * heartbeat list. A monitor with no beats yet is reported as pending rather
 * than dropped, so the page never undercounts its services.
 * @param groups Monitor groups from the config endpoint
 * @param heartbeats Beats keyed by monitor id
 * @returns One entry per monitor, in page order
 */
export function resolveMonitorStates(
    groups: MonitorGroup[],
    heartbeats: Record<string, Heartbeat[]>
): MonitorStateEntry[] {
    const out: MonitorStateEntry[] = [];

    for (const group of groups ?? []) {
        for (const monitor of group.monitorList ?? []) {
            const beats = heartbeats[String(monitor.id)] ?? [];
            const latest = beats[0];

            out.push({
                monitor,
                state: {
                    status: latest ? latest.status : MonitorState.PENDING,
                    ping: latest ? latest.ping : null,
                    msg: latest?.msg ?? "",
                    beats,
                },
            });
        }
    }

    return out;
}
