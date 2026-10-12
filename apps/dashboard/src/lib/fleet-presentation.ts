import type { MetricsPayload, MonitorSummary } from "./api";

export function sampleAgeMs(time: string, now = Date.now()): number {
    const iso = time.replace(" ", "T");
    const timestamp = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Infinity;
}

export function percentage(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value)
        ? "—"
        : `${Math.max(0, Math.min(100, value)).toFixed(value < 10 ? 1 : 0)}%`;
}

type Container = NonNullable<MetricsPayload["docker"]>[number];
export type FleetContainer = Container;

/** Pending-update counts at or above this read as bad (red); below, warn. */
export const UPDATES_RED_AT = 50;

export interface UpdatesStatus {
    label: string;
    tone: "ok" | "warn" | "bad" | "critical";
    title: string;
}

/**
 * One-line pending-update status for a server card. Counts only, never a
 * package list. Absent or malformed data is unknown (null — the card shows
 * nothing) so a blind agent never reads as fully updated. Security takes
 * precedence whenever any are reported.
 */
export function updatesStatus(updates: { total?: number; security?: number } | undefined): UpdatesStatus | null {
    if (!updates) { return null; }
    const { total, security } = updates;
    if (!Number.isFinite(total) || (total as number) < 0) { return null; }
    if (Number.isFinite(security) && (security as number) > 0) {
        return {
            label: `Security Updates: ${security}`,
            tone: "critical",
            title: `${security} security update${security === 1 ? "" : "s"} pending — patch promptly`,
        };
    }
    if (total === 0) {
        return { label: "No updates", tone: "ok", title: "System is fully updated" };
    }
    if ((total as number) >= UPDATES_RED_AT) {
        return { label: `Updates: ${total}`, tone: "bad", title: `${total} pending updates (${UPDATES_RED_AT} or more)` };
    }
    return { label: `Updates: ${total}`, tone: "warn", title: `${total} pending updates` };
}

export function containerTone(container: Container): "up" | "stopped" | "bad" | "pending" {
    if (containerIssue(container)) { return "bad"; }
    if (container.state === "exited" || container.state === "removed") { return "stopped"; }
    if (container.state === "running" && (!container.health || container.health === "healthy")) { return "up"; }
    return "pending";
}

export function containerTileLayout(containers: Container[]) {
    // Reserve at least one rotating row when the fleet overflows. More than
    // six issues cannot all be pinned: remaining issues lead the rotating set.
    const issues = containers.filter(containerIssue);
    const pinned = containers.length > 9 ? issues.slice(0, 6) : [];
    const pinnedSet = new Set(pinned);
    const rotating = containers.filter(container => !pinnedSet.has(container));
    const pinnedRows = Math.ceil(pinned.length / 3);
    const visibleRows = 3 - pinnedRows;
    const rows: Container[][] = [];
    for (let i = 0; i < rotating.length; i += 3) { rows.push(rotating.slice(i, i + 3)); }
    return { pinned, rows, visibleRows, looping: rows.length > visibleRows };
}

// Stopped containers may be intentional. Only explicit malfunction states
// count as issues until expected-running configuration exists.
export function containerIssue(container: Container): boolean {
    return container.state === "dead" || container.state === "restarting" ||
        (container.state === "running" && container.health === "unhealthy");
}

/**
 * Format a byte count compactly. Missing or non-finite reads as "—".
 */
export function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes)) { return "—"; }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Format a throughput in bytes per second, or null when absent so the card
 * can hide it. A real zero reads as "0 B/s": an idle interface is data.
 */
export function formatRate(bytesPerSecond: number | undefined): string | null {
    if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
        return null;
    }
    return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Format a duration in seconds as a compact human string, or null when the
 * value is absent or not finite.
 */
export function formatDuration(seconds: number | undefined): string | null {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) { return null; }
    if (seconds < 60) { return `${Math.floor(seconds)}s`; }
    if (seconds < 3600) { return `${Math.floor(seconds / 60)}m`; }
    if (seconds < 86400) { return `${Math.floor(seconds / 3600)}h`; }
    return `${Math.floor(seconds / 86400)}d`;
}

type AgentMetrics = NonNullable<MetricsPayload["agent"]>;

export interface AgentWarning {
    text: string;
    title: string;
}

/**
 * Human summary of the agent self-report, or null when there is nothing to
 * report — a clean agent adds no card noise.
 *
 * Docker collector errors are deliberately excluded: the containers section
 * already renders dockerError, and printing the same problem twice on one
 * card helps nobody. Counts are cumulative since the agent started, so a
 * warning means "has had trouble", not necessarily "failing right now";
 * the title carries the detail needed to check journald.
 */
export function agentWarnings(agent: AgentMetrics | undefined): AgentWarning | null {
    if (!agent) { return null; }

    const collectorErrors = Object.entries(agent.collectorErrors ?? {})
        .filter(([name, count]) => name !== "docker" && Number.isFinite(count) && count > 0);
    const failedPushes = Number.isFinite(agent.failedPushes) ? agent.failedPushes as number : 0;
    const samplesDropped = Number.isFinite(agent.samplesDropped) ? agent.samplesDropped as number : 0;

    const parts: string[] = [];
    const details: string[] = [];
    if (collectorErrors.length) {
        const total = collectorErrors.reduce((sum, [, count]) => sum + count, 0);
        parts.push(`${total} collector error${total === 1 ? "" : "s"}`);
        details.push(collectorErrors.map(([name, count]) => `${name} ${count}`).join(", "));
    }
    if (failedPushes > 0) {
        parts.push(`${failedPushes} push failure${failedPushes === 1 ? "" : "s"}`);
    }
    if (samplesDropped > 0) {
        parts.push(`${samplesDropped} sample${samplesDropped === 1 ? "" : "s"} dropped`);
    }
    if (!parts.length) { return null; }

    const title: string[] = [ `Agent ${agent.version ?? "unknown"}` ];
    if (agent.uptime !== undefined && Number.isFinite(agent.uptime)) {
        title.push(`running ${formatDuration(agent.uptime) ?? "0s"}`);
    }
    if (details.length) { title.push(`errors: ${details.join("; ")}`); }
    if (agent.lastError) { title.push(`last push error: ${agent.lastError}`); }

    return { text: `Agent: ${parts.join(" · ")}`, title: title.join(" · ") };
}

/**
 * Clean a monitor name typed into the rename dialog: trimmed, capped the
 * way the API caps it, empty when there is nothing to save.
 */
export function cleanMonitorName(input: string): string | null {
    const next = input.trim().slice(0, 255);
    return next.length > 0 ? next : null;
}

/**
 * Clamp a cursor-anchored popup inside the viewport with a margin, so a
 * right-click near the wall's edge never pushes the menu off-screen.
 */
export function clampMenuPosition(
    x: number, y: number, menuWidth: number, menuHeight: number,
    viewportWidth: number, viewportHeight: number, margin = 8,
): { x: number; y: number } {
    return {
        x: Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin)),
        y: Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin)),
    };
}

/**
 * URL slug for a monitor group name: lowercase, runs of anything else
 * become one dash. "Aiel Qorgan" and "aiel-qorgan" address the same board.
 */
export function groupSlug(name: string): string {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface BoardRoute {
    kiosk: boolean;
    /** Raw group filter segment, e.g. "work" or "work,personal". Null for the whole fleet. */
    filter: string | null;
}

/**
 * Resolve a path to a board route, if it is one.
 *
 * /superboard and /superboard/kiosk show the whole fleet; appending a
 * group segment scopes the board, e.g. /superboard/kiosk/work. Anything
 * else (the table, invites) is not a board route.
 */
export function boardRouteFrom(path: string): BoardRoute | null {
    const clean = path.replace(/\/+$/, "") || "/";
    if (clean === "/superboard") {
        return { kiosk: false, filter: null };
    }
    if (clean === "/superboard/kiosk") {
        return { kiosk: true, filter: null };
    }
    let match = /^\/superboard\/kiosk\/(.+)$/.exec(clean);
    if (match) {
        return { kiosk: true, filter: decodeSegment(match[1]) };
    }
    match = /^\/superboard\/([^/]+)$/.exec(clean);
    if (match) {
        // /superboard/kiosk is handled above; anything else here is a scope.
        // (So do not name a group "kiosk": the desk URL would lose to it.)
        return { kiosk: false, filter: decodeSegment(match[1]) };
    }
    return null;
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Match a comma-separated group filter against the roster's groups.
 *
 * Each entry matches a group by slug or case-insensitive exact name; only
 * type "group" monitors can match, so a server that happens to share a
 * name never does. Unknown entries match nothing rather than everything:
 * a mistyped wall URL shows an empty board, not the whole fleet.
 */
export function matchGroups(monitors: MonitorSummary[], filter: string): MonitorSummary[] {
    const groups = monitors.filter((m) => m.type === "group");
    const seen = new Set<number>();
    const out: MonitorSummary[] = [];
    for (const raw of filter.split(",")) {
        const want = raw.trim().toLowerCase();
        if (!want) {
            continue;
        }
        const slug = groupSlug(want);
        for (const group of groups) {
            if (seen.has(group.id)) {
                continue;
            }
            if (groupSlug(group.name) === slug || group.name.toLowerCase() === want) {
                seen.add(group.id);
                out.push(group);
            }
        }
    }
    return out;
}

export function fleetAttention(metrics: MetricsPayload, time: string, interval: number, now = Date.now()) {
    const freshnessWindow = metrics.sampleInterval && Number.isFinite(metrics.sampleInterval) && metrics.sampleInterval > 0
        ? Math.max(5, metrics.sampleInterval * 3) : Math.max(60, interval);
    const stale = sampleAgeMs(time, now) > freshnessWindow * 1000;
    const containers = [...(metrics.docker ?? [])].sort((a, b) =>
        Number(containerIssue(b)) - Number(containerIssue(a)) || (a.name ?? "").localeCompare(b.name ?? ""));
    const issues = containers.filter(containerIssue).length + Number(Boolean(metrics.dockerError));
    const hot = [metrics.cpu?.percent, metrics.mem?.percent, ...(metrics.disk ?? []).map(d => d.percent),
        ...(metrics.gpu?.gpus ?? [metrics.gpu]).flatMap(g => [g?.util,
            g?.memTotal && g.memUsed !== undefined ? g.memUsed / g.memTotal * 100 : undefined])]
        .some(value => value !== undefined && Number.isFinite(value) && value >= 90);
    return { stale, containers, issues, hot };
}
