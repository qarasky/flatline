/**
 * Shapes the Flatline API returns for monitors, metrics, links and backups.
 *
 * Copied from the old dashboard's `src/lib/api.ts` (deleted at the cutover) so the
 * ported board modules keep their types; the old copy goes with the
 * dashboard in part 7 of the rewrite.
 */

export interface MonitorSummary {
    id: number;
    name: string;
    type: string;
    url: string | null;
    /** ICMP target for ping monitors. */
    hostname?: string | null;
    status: number;
    ping: number | null;
    lastCheck: string | null;
    lastMessage: string | null;
    active: boolean;
    interval: number;
    weight?: number;
    parent?: number | null;
    /** Hosting provider id (usually a domain) drawn as a logo on Superboard cards. */
    provider?: string | null;
    // Server-side metric alert thresholds (Superboard Phase 5), null when disabled.
    metricCpuThreshold?: number | null;
    metricRamThreshold?: number | null;
    metricDiskThreshold?: number | null;
    /** Agent counters the operator last acknowledged; the board shows the
     * reported value minus each ack. Reset by the server on agent restart. */
    pushFailuresAck?: number;
    samplesDroppedAck?: number;
    collectorErrorsAck?: Record<string, number>;
    /** This monitor's own mute as a subject (null when none). */
    mute?: MonitorMute | null;
    /** Subjects whose active mute covers this monitor; empty when not muted. */
    mutedBy?: number[];
    uptime24h: number | null;
    uptime7d: number | null;
    uptime30d: number | null;
    tags?: { id: number; name: string; color: string }[];
}

/** An acknowledged outage, as stored on its subject monitor. */
export interface MonitorMute {
    mutedAt: string;
    /** Snapshot monitors still down. */
    monitors: number[];
    /** The subject itself is down and muted (its CPU/RAM and backup alerts are silenced too). */
    hostMuted: boolean;
    smartFailed: string[];
    fullMounts: string[];
}

/** One operator-recorded archive or restore verification. */
export interface BackupVerification {
    runId: string;
    status: "passed" | "failed";
    checkedAt: string;
    summary: string;
}

/** Backup run metadata shared with the Rust receiver and Go agent. */
export interface BackupRunSummary {
    id: string;
    agentId: string;
    clientRunId: string;
    status: "uploading" | "finalizing" | "completed" | "failed" | "expired" | "deleting" | "pruned";
    exportStartedAt: string;
    exportFinishedAt: string | null;
    createdAt: string;
    completedAt: string | null;
    totalBytes: number | null;
    receivedBytes: number;
    sha256: string | null;
    /** Agent-reported. `encrypted` is absent on runs from agents that always encrypted. */
    sourceSummary: { databaseCount: number; objectCount: number; sourceBytes: number; encrypted?: boolean } | null;
    errorCode: string | null;
    archiveVerification: BackupVerification | null;
    restoreVerification: BackupVerification | null;
}

/** A named backup agent linked (or not) to a monitor. */
export interface BackupAgentSummary {
    id: string;
    name: string;
    monitorId: number | null;
    enabled: boolean;
    credentialActive: boolean;
    intervalSeconds: number;
    retentionCount: number;
    createdAt: string;
    health: "disabled" | "pending" | "healthy" | "failed" | "overdue";
    lastErrorCode: string | null;
    latestRun: BackupRunSummary | null;
    lastCompletedRun: BackupRunSummary | null;
    latestArchiveVerification: BackupVerification | null;
    latestRestoreVerification: BackupVerification | null;
    /** Backup-agent version last reported (run start or self-update check-in). */
    reportedVersion: string | null;
    versionReportedAt: string | null;
    /** Outcome of the host's last self-update attempt: `ok` or a code. */
    updateStatus: string | null;
}

export interface HealthSummary {
    total: number;
    up: number;
    down: number;
    pending: number;
    maintenance: number;
    paused: number;
    status: "up" | "down";
    downMonitors: { id: number; name: string; url: string | null }[];
}

export interface Pagination {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
}

export type LiveEvent =
    | { type: "metrics"; monitorId: number; time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null }
    | { type: "heartbeat"; monitorId: number; patch: Partial<MonitorSummary> };

export interface MonitorTypeInfo {
    name: string;
    supportsConditions: boolean;
    allowCustomStatus: boolean;
}

/**
 * One Superboard metrics sample, as stored by the server.
 *
 * The server stores the agent's payload as-is and does not reshape it, so
 * every field is optional from the reader's point of view: an older agent, or
 * a capability that failed on the box (no GPU, no Docker), is legitimately
 * absent. The board must render around missing pieces, not assume them.
 */
export interface MetricsPayload {
    v?: number;
    sampleInterval?: number;
    host?: { hostname?: string; os?: string; uptime?: number };
    cpu?: {
        percent?: number;
        cores?: number;
        perCore?: number[];
        temp?: number;
        counters?: { total?: number; idle?: number; perCore?: { total?: number; idle?: number }[] };
    };
    mem?: { total?: number; used?: number; percent?: number; temp?: number };
    disk?: { mount?: string; total?: number; used?: number; percent?: number }[];
    gpu?: {
        available?: boolean;
        name?: string;
        util?: number;
        memUsed?: number;
        memTotal?: number;
        temp?: number;
        gpus?: { name?: string; util?: number; memUsed?: number; memTotal?: number; temp?: number }[];
    };
    docker?: {
        name?: string;
        image?: string;
        state?: string;
        health?: string;
        ports?: string[];
        uptime?: number;
        stats?: { cpuPercent?: number; memUsed?: number; memLimit?: number; memPercent?: number };
    }[];
    dockerError?: string;
    /** When the container list was last collected completely (RFC3339). */
    dockerAt?: string;
    updates?: { total?: number; security?: number; rebootRequired?: boolean };
    load?: { avg1?: number; avg5?: number; avg15?: number };
    net?: { iface?: string; rxBytes?: number; txBytes?: number }[];
    diskIo?: { device?: string; readBytes?: number; writeBytes?: number }[];
    netRate?: { rxBytesPerSec?: number; txBytesPerSec?: number; windowSeconds?: number };
    diskIoRate?: { readBytesPerSec?: number; writeBytesPerSec?: number; windowSeconds?: number };
    smart?: {
        available?: boolean;
        disks?: {
            device?: string;
            health?: string;
            tempC?: number;
            wearPercent?: number;
            reallocatedSectors?: number;
            powerOnHours?: number;
        }[];
    };
    agent?: {
        version?: string;
        uptime?: number;
        samplesDropped?: number;
        failedPushes?: number;
        lastError?: string;
        collectorErrors?: Record<string, number>;
    };
}

export interface LatestMetrics {
    ok: true;
    monitorId: number;
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
}

export interface CPUPeak {
    percent: number;
    at: string;
}
export type HistoryMetric = "cpu" | "ram" | "gpu" | "vram";
export interface HistoryStats {
    count: number;
    min: number;
    max: number;
    mean: number;
    p90: number;
    p95: number;
    p99: number;
}
export interface HistoryPoint {
    time: string;
    cpu: number | null;
    ram: number | null;
    gpu: number | null;
    vram: number | null;
}
export interface MetricsHistorySummary {
    ok: true;
    monitorId: number;
    hours: number;
    from: string;
    to: string;
    capped: boolean;
    samples: number;
    firstSample: string | null;
    lastSample: string | null;
    bucketSeconds: number;
    percentileMethod: string;
    basis: string;
    stats: Record<HistoryMetric, HistoryStats | null>;
    series: HistoryPoint[];
}

/** A raw stored link: an ordinary monitor, or a group to expand on the card. */
export interface MonitorLinkTarget {
    linkedMonitorId: number;
    name: string;
    type: string;
    status: number;
    ping: number | null;
}

/** A linked website after group expansion, with its current status. */
export interface ResolvedMonitorLink {
    id: number;
    name: string;
    type: string;
    status: number;
    ping: number | null;
    url: string | null;
    lastCheck: string | null;
    /** The raw link that pulled this monitor in (itself, or a group id). */
    via: number;
}

/** Raw and resolved links for one server. */
export interface MonitorLinks {
    raw: MonitorLinkTarget[];
    resolved: ResolvedMonitorLink[];
}

/** A notification config as the monitor form lists it. */
export interface NotificationSummary {
    id: number;
    name: string;
    type: string;
    active: boolean;
    isDefault: boolean;
}
