import type { MetricsPayload, MonitorSummary } from "./api";

// Route parsing lives in ./routes so the entry chunk does not pull in the
// board presentation code; re-exported for existing callers.
export { boardRouteFrom, statusSlugFromPath, type BoardRoute } from "./routes";

/**
 * Parse a stored timestamp (SQL or ISO) into epoch millis.
 * @param value Timestamp
 * @returns Epoch millis, or NaN when unparseable
 */
export function parseTimestamp(value: string | null | undefined): number {
    if (!value) {
        return NaN;
    }
    const iso = value.replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

export function sampleAgeMs(time: string, now = Date.now()): number {
    const timestamp = parseTimestamp(time);
    return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Infinity;
}

/**
 * How old the container list in one sample is, in milliseconds, or null when
 * the payload predates `dockerAt` (older agents).
 *
 * `dockerAt` is the agent's collection time and `time` the sample's own
 * timestamp, so this compares two clocks; both hosts are NTP-synced in
 * practice, and the alternative — asking the agent to send an age — would be
 * stale the moment the sample sat in a buffer. A list that is older than a
 * few collection cycles matters: the agent refreshes containers every 10s, so
 * a stalling daemon used to leave old health looking current under a fresh
 * sample timestamp.
 * @param metrics Sample payload
 * @param time Sample timestamp
 * @returns Age in milliseconds, or null when unknown
 */
export function containerAgeMs(metrics: MetricsPayload, time: string): number | null {
    if (!metrics.dockerAt) {
        return null;
    }
    const sampledAt = parseTimestamp(time);
    if (!Number.isFinite(sampledAt)) {
        return null;
    }
    const age = sampleAgeMs(metrics.dockerAt, sampledAt);
    return Number.isFinite(age) ? age : null;
}

export function percentage(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value)
        ? "—"
        : `${Math.max(0, Math.min(100, value)).toFixed(value < 10 ? 1 : 0)}%`;
}

type Container = NonNullable<MetricsPayload["docker"]>[number];
export type FleetContainer = Container;

/** Pending-update counts at or above this read as a warning (yellow). */
export const UPDATES_WARN_AT = 50;

export interface UpdatesStatus {
    label: string;
    tone: "ok" | "warn" | "quiet" | "critical" | "reboot";
    title: string;
}

/**
 * One-line pending-update status for a server card. Counts only, never a
 * package list. Absent or malformed data is unknown (null — the card shows
 * nothing) so a blind agent never reads as fully updated.
 *
 * Priority is actionability: a pending reboot outranks everything (no further
 * package check will clear it — the host must restart), then security, then a
 * backlog. A handful of pending updates is an ordinary day, so below the
 * threshold the line stays quiet (grey); a real backlog is the warning
 * (yellow). Fully updated is green, security dark red, reboot flashing red.
 */
export function updatesStatus(
    updates: { total?: number; security?: number; rebootRequired?: boolean } | undefined
): UpdatesStatus | null {
    if (!updates) {
        return null;
    }
    const { total, security, rebootRequired } = updates;
    if (!Number.isFinite(total) || (total as number) < 0) {
        return null;
    }
    if (rebootRequired === true) {
        const detail =
            Number.isFinite(security) && (security as number) > 0
                ? `Security Updates: ${security} · reboot required`
                : (total as number) > 0
                  ? `Updates: ${total} · reboot required`
                  : "Reboot required";
        return {
            label: detail,
            tone: "reboot",
            title: "A reboot is required to finish applying updates — patch, then restart the host",
        };
    }
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
    if ((total as number) >= UPDATES_WARN_AT) {
        return {
            label: `Updates: ${total}`,
            tone: "warn",
            title: `${total} pending updates (${UPDATES_WARN_AT} or more)`,
        };
    }
    return { label: `Updates: ${total}`, tone: "quiet", title: `${total} pending updates` };
}

export function containerTone(container: Container): "up" | "stopped" | "bad" | "pending" {
    if (containerIssue(container)) {
        return "bad";
    }
    if (container.state === "exited" || container.state === "removed") {
        return "stopped";
    }
    if (container.state === "running" && (!container.health || container.health === "healthy")) {
        return "up";
    }
    return "pending";
}

/** Containers a card shows at most: the failing ones, or the two busiest. */
export const CONTAINER_ROWS = 2;

/** A deliberately stopped container: never shown, never counted as trouble. */
export function containerStopped(container: Container): boolean {
    return container.state === "exited" || container.state === "removed";
}

/**
 * Rank a container by resource pressure: CPU first (Docker's per-core
 * convention, so 400% means four cores), memory as the tie-break. A container
 * with no stats sorts last rather than reading as idle.
 */
function containerUsage(container: Container): number {
    const cpu = Number.isFinite(container.stats?.cpuPercent) ? (container.stats?.cpuPercent as number) : -1;
    const mem = Number.isFinite(container.stats?.memUsed) ? (container.stats?.memUsed as number) : 0;
    return cpu * 1e12 + mem;
}

/**
 * The containers worth a row on the card.
 *
 * Stopped containers are never shown: without an expected-running policy they
 * express intent, not failure, and they would crowd out live signal. Real
 * failures come first, capped at CONTAINER_ROWS, whatever else is running —
 * an unhealthy container is the one thing the wall exists to surface. When
 * nothing fails, the busiest few earn the space instead, so a healthy card
 * still says something about what the host is actually doing.
 */
export function containerRows(containers: Container[], limit = CONTAINER_ROWS): Container[] {
    const live = containers.filter((container) => !containerStopped(container));
    const failing = live.filter(containerIssue);
    if (failing.length) {
        return failing.slice(0, limit);
    }
    return live
        .filter((container) => container.state === "running")
        .sort((a, b) => containerUsage(b) - containerUsage(a))
        .slice(0, limit);
}

// Stopped containers may be intentional. Only explicit malfunction states
// count as issues until expected-running configuration exists.
export function containerIssue(container: Container): boolean {
    return (
        container.state === "dead" ||
        container.state === "restarting" ||
        (container.state === "running" && container.health === "unhealthy")
    );
}

/**
 * Format a byte count compactly. Missing or non-finite reads as "—".
 */
export function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes)) {
        return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * "used / total" sharing one unit, e.g. "24 / 36 (GB)".
 *
 * Cards are read at a glance, so the unit is printed once. Returns null when
 * either side is unknown, and falls back to two full figures when the units
 * differ (900 GB of 2 TB, say) since one trailing unit would then be a lie.
 * @param used Used bytes
 * @param total Total bytes
 * @returns The paired text, or null when nothing can be shown
 */
export function formatBytesPair(used: number | undefined, total: number | undefined): string | null {
    const u = formatBytes(used);
    const t = formatBytes(total);
    if (u === "—" || t === "—") {
        return null;
    }
    const uSplit = u.lastIndexOf(" ");
    const tSplit = t.lastIndexOf(" ");
    const uUnit = u.slice(uSplit + 1);
    const tUnit = t.slice(tSplit + 1);
    if (uUnit !== tUnit) {
        return `${u} / ${t}`;
    }
    const bare = (value: string) => (value.endsWith(".0") ? value.slice(0, -2) : value);
    return `${bare(u.slice(0, uSplit))} / ${bare(t.slice(0, tSplit))} (${uUnit})`;
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
 * Ultra-compact byte count for container tiles ("512M", "1.5G"), or null
 * when absent. Full formatting lives in the tooltip.
 */
export function formatBytesCompact(bytes: number | undefined): string | null {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
        return null;
    }
    const units = ["B", "K", "M", "G", "T", "P"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const text = value >= 100 || unit === 0 ? `${Math.round(value)}` : value.toFixed(1);
    return `${text}${units[unit]}`;
}

type ContainerStats = NonNullable<NonNullable<MetricsPayload["docker"]>[number]["stats"]>;

/**
 * One-line live stats for a container tile plus the tooltip detail.
 *
 * Docker's CPU convention is percent of a single core, so a container using
 * four cores reads 400% — that is the number docker stats shows, and
 * normalising it here would hide which container is actually busy. Returns
 * null when nothing is known: a statless container must show nothing, never
 * a fake zero.
 */
export function containerStatsSummary(stats: ContainerStats | undefined): { label: string; title: string } | null {
    if (!stats) {
        return null;
    }
    const cpu = Number.isFinite(stats.cpuPercent) ? (stats.cpuPercent as number) : null;
    const mem = stats.memUsed !== undefined && Number.isFinite(stats.memUsed) ? (stats.memUsed as number) : null;
    if (cpu === null && mem === null) {
        return null;
    }

    const cpuText = cpu === null ? null : cpu === 0 ? "0%" : cpu < 10 ? `${cpu.toFixed(1)}%` : `${Math.round(cpu)}%`;
    const memText = mem === null ? null : formatBytesCompact(mem);
    const label = [cpuText, memText].filter(Boolean).join(" · ");

    const titleParts: string[] = [];
    if (cpu !== null) {
        titleParts.push(`CPU ${cpu.toFixed(1)}%`);
    }
    if (mem !== null) {
        const limit =
            stats.memLimit !== undefined && Number.isFinite(stats.memLimit) && stats.memLimit > 0
                ? stats.memLimit
                : null;
        const percent = Number.isFinite(stats.memPercent) ? Math.round(stats.memPercent as number) : null;
        titleParts.push(
            limit
                ? `memory ${formatBytes(mem)} of ${formatBytes(limit)}${percent !== null ? ` (${percent}%)` : ""}`
                : `memory ${formatBytes(mem)}`
        );
    }
    return { label, title: titleParts.join(" · ") };
}

/**
 * Format a duration in seconds as a compact human string, or null when the
 * value is absent or not finite.
 */
export function formatDuration(seconds: number | undefined): string | null {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    if (seconds < 60) {
        return `${Math.floor(seconds)}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)}h`;
    }
    return `${Math.floor(seconds / 86400)}d`;
}

/**
 * How long ago a timestamp was, as `Xs`/`Xm`/`Xh`/`Xd` ("0s" for now or the
 * future), or "—" when there is none.
 * @param value Timestamp
 * @param now Current time in milliseconds
 */
export function ageOf(value: string | null | undefined, now = Date.now()): string {
    if (!value) {
        return "—";
    }
    const age = sampleAgeMs(value, now);
    return Number.isFinite(age) ? (formatDuration(age / 1000) ?? "0s") : "—";
}

type AgentMetrics = NonNullable<MetricsPayload["agent"]>;

/**
 * The acknowledged agent counters for one monitor: the `*Ack` fields of its
 * MonitorSummary. All optional, since a monitor may carry none.
 */
export interface AgentAcks {
    pushFailuresAck?: number;
    samplesDroppedAck?: number;
    collectorErrorsAck?: Record<string, number>;
}

export interface AgentWarningCounts {
    /** Collector failures still outstanding, docker excluded. */
    collectorErrors: number;
    failedPushes: number;
    samplesDropped: number;
    /** Outstanding per-collector detail, docker excluded. */
    collectors: [string, number][];
    /** Everything the card prints, for the menu's "Clear (N)". */
    total: number;
}

/**
 * Count the agent warnings still outstanding, after subtracting the
 * acknowledged values.
 *
 * Docker collector errors are excluded: the containers section already
 * renders dockerError, and printing the same problem twice on one card helps
 * nobody. Counts are cumulative since the agent started, so the ack marks the
 * value the operator has seen; the server drops a stale ack when the agent
 * restarts, so this subtraction can never hide a new failure.
 */
export function agentWarningCounts(agent: AgentMetrics | undefined, acks: AgentAcks = {}): AgentWarningCounts {
    const empty: AgentWarningCounts = {
        collectorErrors: 0,
        failedPushes: 0,
        samplesDropped: 0,
        collectors: [],
        total: 0,
    };
    if (!agent) {
        return empty;
    }

    const collectors: [string, number][] = Object.entries(agent.collectorErrors ?? {})
        .filter(([name, count]) => name !== "docker" && Number.isFinite(count))
        .map(([name, count]): [string, number] => [
            name,
            Math.max(0, (count as number) - Math.max(0, acks.collectorErrorsAck?.[name] ?? 0)),
        ])
        .filter(([, count]) => count > 0);
    const collectorErrors = collectors.reduce((sum, [, count]) => sum + count, 0);

    const reported = Number.isFinite(agent.failedPushes) ? (agent.failedPushes as number) : 0;
    const failedPushes = Math.max(0, reported - Math.max(0, acks.pushFailuresAck ?? 0));
    const dropped = Number.isFinite(agent.samplesDropped) ? (agent.samplesDropped as number) : 0;
    const samplesDropped = Math.max(0, dropped - Math.max(0, acks.samplesDroppedAck ?? 0));

    return {
        collectorErrors,
        failedPushes,
        samplesDropped,
        collectors,
        total: collectorErrors + failedPushes + samplesDropped,
    };
}

export interface AgentWarning {
    text: string;
    title: string;
}

/**
 * Human summary of the agent self-report, or null when there is nothing to
 * report — a clean agent adds no card noise.
 *
 * The counts come from {@link agentWarningCounts}, so acknowledged values are
 * already subtracted; the title carries the detail needed to check journald.
 */
export function agentWarnings(agent: AgentMetrics | undefined, acks: AgentAcks = {}): AgentWarning | null {
    if (!agent) {
        return null;
    }

    const counts = agentWarningCounts(agent, acks);
    const parts: string[] = [];
    const details: string[] = [];
    if (counts.collectorErrors > 0) {
        parts.push(`${counts.collectorErrors} collector error${counts.collectorErrors === 1 ? "" : "s"}`);
        details.push(counts.collectors.map(([name, count]) => `${name} ${count}`).join(", "));
    }
    if (counts.failedPushes > 0) {
        parts.push(`${counts.failedPushes} push failure${counts.failedPushes === 1 ? "" : "s"}`);
    }
    if (counts.samplesDropped > 0) {
        parts.push(`${counts.samplesDropped} sample${counts.samplesDropped === 1 ? "" : "s"} dropped`);
    }
    if (!parts.length) {
        return null;
    }

    const title: string[] = [`Agent ${agent.version ?? "unknown"}`];
    if (agent.uptime !== undefined && Number.isFinite(agent.uptime)) {
        title.push(`running ${formatDuration(agent.uptime) ?? "0s"}`);
    }
    if (details.length) {
        title.push(`errors: ${details.join("; ")}`);
    }
    if (agent.lastError) {
        title.push(`last push error: ${agent.lastError}`);
    }

    return { text: `Agent: ${parts.join(" · ")}`, title: title.join(" · ") };
}

type SmartInfo = NonNullable<MetricsPayload["smart"]>;

/**
 * One warning line for disk health, or null when there is nothing to say.
 *
 * Failing health outranks wear; wear only speaks at 80% used or above.
 * Healthy disks stay silent — the card is a wall display, and "all disks
 * fine" is not news. The tooltip always carries the per-disk detail when a
 * warning is shown.
 */
export function smartWarning(
    smart: SmartInfo | undefined
): { text: string; title: string; tone: "warn" | "bad" } | null {
    if (!smart?.available || !smart.disks?.length) {
        return null;
    }

    const title = smart.disks
        .map((disk) => {
            const bits = [disk.health ?? "health unknown"];
            if (Number.isFinite(disk.tempC)) {
                bits.push(`${Math.round(disk.tempC as number)}°C`);
            }
            if (Number.isFinite(disk.wearPercent)) {
                bits.push(`wear ${Math.round(disk.wearPercent as number)}%`);
            }
            if (Number.isFinite(disk.reallocatedSectors) && (disk.reallocatedSectors as number) > 0) {
                bits.push(`${disk.reallocatedSectors} reallocated`);
            }
            if (disk.powerOnHours) {
                bits.push(`${Math.round(disk.powerOnHours / 24)}d on`);
            }
            return `${disk.device ?? "disk"}: ${bits.join(", ")}`;
        })
        .join(" · ");

    const failing = smart.disks.filter((disk) => disk.health === "failed");
    if (failing.length) {
        const names = failing.map((disk) => disk.device ?? "disk");
        return {
            tone: "bad",
            text: names.length === 1 ? `SMART ${names[0]}: failing` : `SMART: ${names.length} disks failing`,
            title,
        };
    }

    const worn = smart.disks.filter((disk) => Number.isFinite(disk.wearPercent) && (disk.wearPercent as number) >= 80);
    if (worn.length) {
        const worst = worn.reduce((a, b) => ((b.wearPercent as number) > (a.wearPercent as number) ? b : a));
        return {
            tone: "warn",
            text: `SSD wear ${Math.round(worst.wearPercent as number)}% (${worst.device ?? "disk"})`,
            title,
        };
    }

    return null;
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
    x: number,
    y: number,
    menuWidth: number,
    menuHeight: number,
    viewportWidth: number,
    viewportHeight: number,
    margin = 8
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
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Whether a server's latest sample is older than its freshness window:
 * three agent sample intervals (at least 5 s) when the agent reports one,
 * otherwise the monitor interval (at least 60 s).
 */
export function isSampleStale(metrics: MetricsPayload, time: string, interval: number, now = Date.now()): boolean {
    const freshnessWindow =
        metrics.sampleInterval && Number.isFinite(metrics.sampleInterval) && metrics.sampleInterval > 0
            ? Math.max(5, metrics.sampleInterval * 3)
            : Math.max(60, interval);
    return sampleAgeMs(time, now) > freshnessWindow * 1000;
}

/** Whether a 10-minute CPU peak is still inside its window. */
export function isPeakFresh(at: string | null | undefined, now = Date.now()): boolean {
    return Boolean(at) && sampleAgeMs(at as string, now) <= 10 * 60_000;
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
    const stale = isSampleStale(metrics, time, interval, now);
    const containers = [...(metrics.docker ?? [])].sort(
        (a, b) => Number(containerIssue(b)) - Number(containerIssue(a)) || (a.name ?? "").localeCompare(b.name ?? "")
    );
    const issues = containers.filter(containerIssue).length + Number(Boolean(metrics.dockerError));
    const hot = [
        metrics.cpu?.percent,
        metrics.mem?.percent,
        ...(metrics.disk ?? []).map((d) => d.percent),
        ...(metrics.gpu?.gpus ?? [metrics.gpu]).flatMap((g) => [
            g?.util,
            g?.memTotal && g.memUsed !== undefined ? (g.memUsed / g.memTotal) * 100 : undefined,
        ]),
    ].some((value) => value !== undefined && Number.isFinite(value) && value >= 90);
    return { stale, containers, issues, hot };
}
