/**
 * Client for the Flatline REST API v1.
 *
 * The dashboard runs in the browser (the API is same-origin or CORS-enabled),
 * so it holds a bearer token rather than a session cookie. That is the same
 * token shape an agent uses, which keeps one auth model instead of two.
 */

const BASE = (import.meta.env?.VITE_FLATLINE_URL as string | undefined) ?? "";

const TOKEN_KEY = "flatline.token";

/**
 * Session copy of the token.
 *
 * Storage can be unavailable or fail (private mode, blocked third-party
 * storage, quota/security errors). The token must still work for the current
 * session in that case — login succeeded, so the operator is authenticated —
 * so it lives in memory as the fallback, and storage is only the
 * persistence layer.
 */
let memoryToken: string | null = null;

/**
 * Read the operator's token: storage when it answers, the session copy
 * otherwise.
 * @returns The token, or null
 */
export function getToken(): string | null {
    try {
        const stored = window.localStorage.getItem(TOKEN_KEY);
        if (stored !== null) {
            // Keep the session copy warm for a later storage failure.
            memoryToken = stored;
            return stored;
        }
    } catch {
        // Storage unavailable; fall through to the session copy.
    }
    return memoryToken;
}

/**
 * Persist the operator's token and remember it for this session.
 * @param token Token to store, or null to forget it
 */
export function setToken(token: string | null): void {
    memoryToken = token;
    try {
        if (token) {
            window.localStorage.setItem(TOKEN_KEY, token);
        } else {
            window.localStorage.removeItem(TOKEN_KEY);
        }
    } catch {
        // Storage can be unavailable (private mode); the session continues
        // on the in-memory copy, the token just will not persist.
    }
}

export interface ApiErrorBody {
    ok: false;
    error: string;
    message: string;
}

/** Error carrying the API's machine-readable code. */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

/**
 * Perform an authenticated request.
 * @param path API path, e.g. "/api/v1/monitors"
 * @param init Fetch options
 * @returns Parsed body
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = getToken();

    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init.headers,
        },
    });

    if (!response.ok) {
        let body: Partial<ApiErrorBody> = {};
        try {
            body = await response.json();
        } catch {
            // Non-JSON error body; fall back to the status.
        }
        throw new ApiError(response.status, body.error ?? "unknown", body.message ?? response.statusText);
    }

    return (await response.json()) as T;
}

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
    uptime24h: number | null;
    uptime7d: number | null;
    uptime30d: number | null;
    tags?: { id: number; name: string; color: string }[];
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
    sourceSummary: { databaseCount: number; objectCount: number; sourceBytes: number } | null;
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

/**
 * Fetch the aggregate health summary.
 * @param signal Cancels the request when the caller's deadline fires
 * @returns Health counts for every monitor
 */
export function fetchHealth(signal?: AbortSignal): Promise<{ ok: true; health: HealthSummary }> {
    return request("/api/v1/health", { signal });
}

/**
 * Fetch monitors.
 * @param params Optional filters
 * @param signal Cancels the request when the caller's deadline fires
 * @returns Monitors plus pagination metadata
 */
export function fetchMonitors(
    params: { status?: string; q?: string; page?: number; perPage?: number } = {},
    signal?: AbortSignal
): Promise<{
    ok: true;
    count: number;
    monitors: MonitorSummary[];
    pagination: Pagination;
}> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            query.set(key, String(value));
        }
    }

    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request(`/api/v1/monitors${suffix}`, { signal });
}

/**
 * Roster snapshots are infrequent; never silently truncate a larger fleet.
 * @param signal Cancels the paging loop when the caller's deadline fires
 * @returns Every monitor
 */
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

export type LiveEvent =
    | { type: "metrics"; monitorId: number; time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null }
    | { type: "heartbeat"; monitorId: number; patch: Partial<MonitorSummary> };

/** Fetch-based SSE keeps credentials in Authorization, never URLs/cookies.
 * Reconnect resnapshots before applying buffered deltas, closing the race
 * between a REST snapshot and updates that arrive while it is loading.
 *
 * Snapshots run under their own deadline and never overlap: a roster or bulk
 * request that never settles used to stall the stream reader (and the
 * catch-path snapshot before it) forever, leaving `connected` true, no error
 * callback and no fallback polling — the audit's reproduction. Recovery now
 * schedules the reconnect independently of snapshot completion.
 */
export function watchLive(options: {
    metrics?: boolean;
    snapshot: (signal?: AbortSignal) => Promise<void>;
    event: (event: LiveEvent) => void;
    error: (error: Error) => void;
    /** Called after every (re)connect snapshot, for data the snapshot does not cover. */
    ready?: () => void;
    /** Backup agents, runs or verifications changed (the event carries no data). */
    backups?: () => void;
    /** Deadline for one snapshot; overridable for tests. */
    snapshotTimeoutMs?: number;
    /** Abort the stream after this much silence; overridable for tests. */
    watchdogMs?: number;
}): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let connected = false;
    let generation = 0;

    /** A hung snapshot must be abandoned, not awaited forever. */
    const SNAPSHOT_DEADLINE_MS = options.snapshotTimeoutMs ?? 15_000;
    /** Silence that means the stream is dead even if the socket is not. */
    const STREAM_WATCHDOG_MS = options.watchdogMs ?? 45_000;
    let snapshotAbort: AbortController | null = null;
    let snapshotInFlight: Promise<void> | null = null;

    /**
     * Run the snapshot under a deadline, refusing to overlap an in-flight
     * one. The abort signal is passed to the snapshot so its fetches are
     * actually cancelled, not just abandoned.
     * @returns Resolves when the snapshot finished; rejects on failure
     */
    function runSnapshot(): Promise<void> {
        if (snapshotInFlight) {
            return snapshotInFlight;
        }
        const abort = new AbortController();
        snapshotAbort = abort;
        const deadline = setTimeout(() => abort.abort(new Error("Snapshot timed out")), SNAPSHOT_DEADLINE_MS);
        const inflight = Promise.resolve()
            .then(() => options.snapshot(abort.signal))
            .finally(() => {
                clearTimeout(deadline);
                if (snapshotAbort === abort) {
                    snapshotAbort = null;
                }
                snapshotInFlight = null;
            });
        snapshotInFlight = inflight;
        return inflight;
    }

    /**
     * Await the snapshot, but give up as soon as the stream itself is dead.
     *
     * A snapshot that outlives its stream is re-joined by the reconnect
     * handler (snapshots never overlap), so the reader must not sit on it:
     * recovery is a property of the stream, not of the snapshot.
     * @param promise Snapshot in flight
     * @param signal The stream's abort signal
     * @returns The snapshot's result, or a rejection once the stream dies
     */
    function untilStreamDies<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new Error("Live stream aborted while snapshotting"));
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
                (value) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                }
            );
        });
    }

    async function connect() {
        if (stopped) {
            return;
        }
        const epoch = ++generation;
        controller = new AbortController();
        const currentController = controller;
        let watchdog = setTimeout(() => currentController.abort(), STREAM_WATCHDOG_MS);
        try {
            const token = getToken();
            const response = await fetch(`${BASE}/api/v1/events${options.metrics === false ? "?metrics=0" : ""}`, {
                headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new ApiError(response.status, "live_stream", response.statusText);
            }
            if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
                throw new Error("Live stream unavailable");
            }
            connected = true;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                while (!stopped && epoch === generation) {
                    const chunk = await reader.read();
                    clearTimeout(watchdog);
                    watchdog = setTimeout(() => currentController.abort(), STREAM_WATCHDOG_MS);
                    if (chunk.done) {
                        throw new Error("Live connection closed; reconnecting");
                    }
                    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
                    if (buffer.length > 1024 * 1024) {
                        throw new Error("Live frame exceeds limit");
                    }
                    let boundary;
                    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                        if (stopped || epoch !== generation) {
                            break;
                        }
                        const frame = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        const data = frame
                            .split("\n")
                            .filter((line) => line.startsWith("data:"))
                            .map((line) => line.slice(5).trimStart())
                            .join("\n");
                        if (!data) {
                            continue;
                        }
                        const event = JSON.parse(data);
                        if (event.type === "unauthorized") {
                            throw new ApiError(401, "unauthorized", "Live token expired or revoked");
                        }
                        if (event.type === "ready" || event.type === "invalidate") {
                            await untilStreamDies(runSnapshot(), currentController.signal);
                            delay = 1000;
                            if (event.type === "ready" && !stopped && epoch === generation) {
                                options.ready?.();
                            }
                        } else if (event.type === "backups") {
                            if (!stopped && epoch === generation) {
                                options.backups?.();
                            }
                        } else if (
                            (event.type === "metrics" || event.type === "heartbeat") &&
                            !stopped &&
                            epoch === generation
                        ) {
                            options.event(event);
                        }
                    }
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        } catch (error) {
            if (stopped || epoch !== generation) {
                return;
            }
            connected = false;
            const failure = error instanceof Error ? error : new Error("Live stream disconnected");
            options.error(failure);
            if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
                stopped = true;
                clearInterval(fallback);
                return;
            }
            // Recover on a timer that does not depend on the snapshot: the
            // snapshot is bounded and coalesced, and the reconnect's own
            // reader awaits it before applying deltas anyway.
            retry = setTimeout(() => void connect(), delay + Math.random() * 500);
            delay = Math.min(15_000, delay * 2);
            void runSnapshot().catch(() => {
                /* reconnect retries the snapshot */
            });
        } finally {
            clearTimeout(watchdog);
        }
    }
    // Compatibility fallback while a proxy/server cannot stream. Never poll
    // whole rosters while the live connection is healthy, and never stack
    // snapshots: runSnapshot coalesces them and bounds each one.
    const fallback = setInterval(() => {
        if (!stopped && !connected && !document.hidden) {
            void runSnapshot().catch((error) => options.error(error));
        }
    }, 30_000);
    void connect();
    return () => {
        stopped = true;
        generation++;
        controller?.abort();
        snapshotAbort?.abort();
        clearTimeout(retry);
        clearInterval(fallback);
    };
}

/**
 * Pause a monitor.
 * @param id Monitor id
 * @returns The updated monitor
 */
export function pauseMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary }> {
    return request(`/api/v1/monitors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
    });
}

/**
 * Resume a monitor.
 * @param id Monitor id
 * @returns The updated monitor
 */
export function resumeMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary }> {
    return request(`/api/v1/monitors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
    });
}

export interface MonitorTypeInfo {
    name: string;
    supportsConditions: boolean;
    allowCustomStatus: boolean;
}

/**
 * Fetch supported monitor types and writable fields.
 * Used to populate the type picker with live server data.
 */
export function fetchMonitorTypes(): Promise<{
    ok: true;
    count: number;
    types: Record<string, MonitorTypeInfo>;
    writableFields: string[];
}> {
    return request("/api/v1/monitor-types");
}

/**
 * Fetch a single monitor with full detail.
 * @param id Monitor id
 * @param signal Cancels the request when the caller's deadline fires
 * @returns The monitor's full record
 */
export function fetchMonitor(
    id: number,
    signal?: AbortSignal
): Promise<{ ok: true; monitor: MonitorSummary & Record<string, unknown> }> {
    return request(`/api/v1/monitors/${id}`, { signal });
}

/**
 * Create a monitor.
 * Unknown fields are ignored server-side and reported back.
 */
export function createMonitor(payload: Record<string, unknown>): Promise<{
    ok: true;
    monitor: MonitorSummary;
    ignoredFields: string[];
}> {
    return request("/api/v1/monitors", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

/**
 * Partially update a monitor. Only supplied fields change.
 */
export function updateMonitor(
    id: number,
    payload: Record<string, unknown>
): Promise<{ ok: true; monitor: MonitorSummary; ignoredFields: string[] }> {
    return request(`/api/v1/monitors/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
    });
}

/**
 * Delete a monitor.
 */
export function deleteMonitor(
    id: number,
    deleteChildren = false
): Promise<{ ok: true; deleted: number[]; count: number }> {
    const suffix = deleteChildren ? "?deleteChildren=true" : "";
    return request(`/api/v1/monitors/${id}${suffix}`, { method: "DELETE" });
}

/**
 * Acknowledge every agent warning counter at once: `failedPushes`,
 * `samplesDropped` and the per-collector `collectorErrors`.
 *
 * The agent owns the counters; the server stores the acknowledged values and
 * the board shows the difference, so this clears the whole "Agent: …" line
 * without touching the agent (there is no server-to-agent channel). The acks
 * are dropped automatically when the agent restarts and its counters reset.
 */
export function clearAgentWarnings(id: number): Promise<{
    ok: true;
    id: number;
    pushFailuresAck: number;
    samplesDroppedAck: number;
    collectorErrorsAck: Record<string, number>;
    reported: Record<string, unknown>;
}> {
    return request(`/api/v1/monitors/${id}/agent-warnings/clear`, { method: "POST" });
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

export function fetchMetricsHistory(id: number, hours: number, signal?: AbortSignal): Promise<MetricsHistorySummary> {
    return request(`/api/v1/monitors/${id}/metrics/summary?hours=${hours}`, { signal });
}

/**
 * Fetch the most recent metrics samples for many monitors at once.
 *
 * Unknown ids and monitors without samples come back as null entries, which
 * is how the Superboard discovers servers without paying a request per id.
 * @param ids Monitor ids (max 200)
 * @param signal Cancels the request when the caller's deadline fires
 * @returns Samples keyed by monitor id, null where missing
 */
export function fetchLatestMetricsBulk(
    ids: number[],
    signal?: AbortSignal
): Promise<{
    ok: true;
    count: number;
    samples: Record<number, { time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null } | null>;
}> {
    return request(`/api/v1/monitors/metrics/latest?ids=${ids.join(",")}`, { signal });
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

/**
 * Fetch one server's linked websites.
 * @param id Server monitor id
 * @param signal Cancels the request when the caller's deadline fires
 * @returns Raw and resolved links
 */
export function fetchMonitorLinks(
    id: number,
    signal?: AbortSignal
): Promise<{ ok: true; monitorId: number } & MonitorLinks> {
    return request(`/api/v1/monitors/${id}/links`, { signal });
}

/**
 * Fetch links for many servers at once for the Superboard.
 *
 * Servers without links are absent from `servers`, keyed by monitor id.
 * @param ids Server monitor ids (max 200)
 * @param signal Cancels the request when the caller's deadline fires
 * @returns Links keyed by server id
 */
export function fetchBulkMonitorLinks(
    ids: number[],
    signal?: AbortSignal
): Promise<{
    ok: true;
    count: number;
    servers: Record<string, MonitorLinks>;
}> {
    return request(`/api/v1/monitors/links?ids=${ids.join(",")}`, { signal });
}

/**
 * Replace a server's linked websites with exactly the supplied ids.
 * @param id Server monitor id
 * @param linkedMonitorIds Desired linked monitor ids
 * @returns The server's links after the update
 */
export function replaceMonitorLinks(
    id: number,
    linkedMonitorIds: number[]
): Promise<{ ok: true; monitorId: number } & MonitorLinks> {
    return request(`/api/v1/monitors/${id}/links`, {
        method: "PUT",
        body: JSON.stringify({ linkedMonitorIds }),
    });
}

export interface ApiKeySummary {
    id: number;
    name: string;
    userID: string;
    createdDate: string;
    active: boolean;
    expires: string | null;
    status: "active" | "inactive" | "expired";
    scopes: string[];
}
/**
 * List this token's sibling tokens (same user). Secrets are never returned.
 */
export function fetchApiKeys(): Promise<{
    ok: true;
    count: number;
    apiKeys: ApiKeySummary[];
    availableScopes: string[];
}> {
    return request("/api/v1/api-keys");
}

/**
 * Mint a token. The plaintext comes back exactly once.
 */
export function createApiKey(payload: {
    name: string;
    scopes?: string | string[];
    active?: boolean;
    expires?: string | null;
}): Promise<{
    ok: true;
    apiKey: ApiKeySummary;
    token: string;
}> {
    return request("/api/v1/api-keys", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

/**
 * Enable or disable a token.
 */
export function setApiKeyActive(id: number, active: boolean): Promise<{ ok: true; apiKey: ApiKeySummary }> {
    return request(`/api/v1/api-keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
    });
}

/**
 * Revoke a token.
 */
export function deleteApiKey(id: number): Promise<{ ok: true; deleted: number }> {
    return request(`/api/v1/api-keys/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Authentication.
//
// Flatline is a single-operator instance: the server's model is "one token
// signs you in". There are no accounts, invites or TOTP — the dashboard
// exchanges an operator token for a stored bearer token, the same credential
// shape an agent uses. No session cookie, no Socket.IO.
// ---------------------------------------------------------------------------

export interface AuthUser {
    id: string;
    username: string | null;
    name: string;
    banned?: boolean;
}

export interface LoginResult {
    ok: true;
    token: string;
    user: AuthUser;
}

/**
 * Exchange the operator token for a bearer token.
 *
 * The token travels in the `password` field: the server accepts it there so
 * the sign-in form needs exactly one input.
 */
export function login(payload: { password: string }): Promise<LoginResult> {
    return request("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

/**
 * The current token's identity and scopes.
 */
export function fetchMe(): Promise<{ ok: true; user: AuthUser; scopes: string[] }> {
    return request("/api/v1/auth/me");
}

/**
 * Linked backup agents for a monitor, or every agent when no id is given.
 * @param monitorId Optional monitor link
 * @param signal Cancels the request
 */
export function fetchBackupAgents(
    monitorId?: number,
    signal?: AbortSignal
): Promise<{ ok: true; agents: BackupAgentSummary[]; nextCursor: string | null }> {
    const suffix = monitorId === undefined ? "" : `?monitorId=${encodeURIComponent(String(monitorId))}`;
    return request(`/api/v1/backup-agents${suffix}`, { signal });
}

/**
 * Newest-first run history for one agent.
 * @param agentId Agent UUID
 * @param signal Cancels the request
 */
export function fetchBackupRuns(
    agentId: string,
    signal?: AbortSignal
): Promise<{ ok: true; runs: BackupRunSummary[]; nextCursor: string | null }> {
    return request(`/api/v1/backup-agents/${encodeURIComponent(agentId)}/runs`, { signal });
}

/**
 * A single-use URL for one completed bundle. The server binds the ticket to
 * the run, expires it within minutes and consumes it on first use, so the
 * browser can stream the bundle to disk with a plain navigation: nothing is
 * buffered in JavaScript and no long-lived token ever appears in a URL.
 * @param runId Run UUID
 * @param signal Cancels the ticket request
 */
export async function backupDownloadUrl(runId: string, signal?: AbortSignal): Promise<string> {
    const result = await request<{ ok: true; runId: string; url: string; expiresAt: string }>(
        `/api/v1/backup-runs/${encodeURIComponent(runId)}/download-ticket`,
        { method: "POST", signal }
    );
    return `${BASE}${result.url}`;
}
