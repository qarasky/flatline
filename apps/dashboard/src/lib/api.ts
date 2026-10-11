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
 * Read the operator's token from local storage.
 * @returns The token, or null
 */
export function getToken(): string | null {
    try {
        return window.localStorage.getItem(TOKEN_KEY);
    } catch {
        return null;
    }
}

/**
 * Persist the operator's token.
 * @param token Token to store, or null to forget it
 */
export function setToken(token: string | null): void {
    try {
        if (token) {
            window.localStorage.setItem(TOKEN_KEY, token);
        } else {
            window.localStorage.removeItem(TOKEN_KEY);
        }
    } catch {
        // Storage can be unavailable (private mode); the app still works for
        // the current session, the token just will not persist.
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

    return await response.json() as T;
}

export interface MonitorSummary {
    id: number;
    name: string;
    type: string;
    url: string | null;
    status: number;
    ping: number | null;
    lastCheck: string | null;
    lastMessage: string | null;
    active: boolean;
    interval: number;
    weight?: number;
    parent?: number | null;
    uptime24h: number | null;
    uptime7d: number | null;
    uptime30d: number | null;
    tags?: { id: number; name: string; color: string }[];
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
 * @returns Health counts for every monitor
 */
export function fetchHealth(): Promise<{ ok: true; health: HealthSummary }> {
    return request("/api/v1/health");
}

/**
 * Fetch monitors.
 * @param params Optional filters
 * @returns Monitors plus pagination metadata
 */
export function fetchMonitors(params: { status?: string; q?: string; page?: number; perPage?: number } = {}): Promise<{
    ok: true;
    count: number;
    monitors: MonitorSummary[];
    pagination: Pagination;
}> {
    const query = new URLSearchParams();
    for (const [ key, value ] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            query.set(key, String(value));
        }
    }

    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request(`/api/v1/monitors${suffix}`);
}

/** Roster snapshots are infrequent; never silently truncate a larger fleet. */
export async function fetchAllMonitors(): Promise<MonitorSummary[]> {
    const monitors: MonitorSummary[] = [];
    for (let page = 1; ; page++) {
        const result = await fetchMonitors({ page, perPage: 200 });
        monitors.push(...result.monitors);
        if (!result.pagination.hasMore) { return monitors; }
    }
}

export type LiveEvent =
    | { type: "metrics"; monitorId: number; time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null }
    | { type: "heartbeat"; monitorId: number; patch: Partial<MonitorSummary> };

/** Fetch-based SSE keeps credentials in Authorization, never URLs/cookies.
 * Reconnect resnapshots before applying buffered deltas, closing the race
 * between a REST snapshot and updates that arrive while it is loading.
 */
export function watchLive(options: {
    metrics?: boolean;
    snapshot: () => Promise<void>;
    event: (event: LiveEvent) => void;
    error: (error: Error) => void;
}): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let connected = false;
    let generation = 0;
    async function connect() {
        if (stopped) { return; }
        const epoch = ++generation;
        controller = new AbortController();
        const currentController = controller;
        let watchdog = setTimeout(() => currentController.abort(), 45_000);
        try {
            const token = getToken();
            const response = await fetch(`${BASE}/api/v1/events${options.metrics === false ? "?metrics=0" : ""}`, {
                headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                signal: controller.signal,
            });
            if (!response.ok) { throw new ApiError(response.status, "live_stream", response.statusText); }
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
                    watchdog = setTimeout(() => currentController.abort(), 45_000);
                    if (chunk.done) { throw new Error("Live connection closed; reconnecting"); }
                    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
                    if (buffer.length > 1024 * 1024) { throw new Error("Live frame exceeds limit"); }
                    let boundary;
                    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                        if (stopped || epoch !== generation) { break; }
                        const frame = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                        if (!data) { continue; }
                        const event = JSON.parse(data);
                        if (event.type === "unauthorized") { throw new ApiError(401, "unauthorized", "Live token expired or revoked"); }
                        if (event.type === "ready" || event.type === "invalidate") {
                            await options.snapshot();
                            delay = 1000;
                        } else if ((event.type === "metrics" || event.type === "heartbeat") && !stopped && epoch === generation) {
                            options.event(event);
                        }
                    }
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        } catch (error) {
            if (stopped || epoch !== generation) { return; }
            connected = false;
            const failure = error instanceof Error ? error : new Error("Live stream disconnected");
            options.error(failure);
            if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
                stopped = true;
                clearInterval(fallback);
                return;
            }
            try { await options.snapshot(); } catch { /* reconnect retries the snapshot */ }
            if (stopped || epoch !== generation) { return; }
            retry = setTimeout(() => void connect(), delay + Math.random() * 500);
            delay = Math.min(15_000, delay * 2);
        } finally {
            clearTimeout(watchdog);
        }
    }
    // Compatibility fallback while a proxy/server cannot stream. Never poll
    // whole rosters while the live connection is healthy.
    const fallback = setInterval(() => {
        if (!stopped && !connected && !document.hidden) {
            void options.snapshot().catch(error => options.error(error));
        }
    }, 30_000);
    void connect();
    return () => {
        stopped = true;
        generation++;
        controller?.abort();
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
 */
export function fetchMonitor(id: number): Promise<{ ok: true; monitor: MonitorSummary & Record<string, unknown> }> {
    return request(`/api/v1/monitors/${id}`);
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
export function deleteMonitor(id: number, deleteChildren = false): Promise<{ ok: true; deleted: number[]; count: number }> {
    const suffix = deleteChildren ? "?deleteChildren=true" : "";
    return request(`/api/v1/monitors/${id}${suffix}`, { method: "DELETE" });
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
        percent?: number; cores?: number; perCore?: number[]; temp?: number;
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
    docker?: { name?: string; image?: string; state?: string; health?: string; ports?: string[]; uptime?: number }[];
    dockerError?: string;
    updates?: { total?: number; security?: number };
}

export interface LatestMetrics {
    ok: true;
    monitorId: number;
    time: string;
    metrics: MetricsPayload;
    cpuPeak10m?: CPUPeak | null;
}

export interface CPUPeak { percent: number; at: string }
export type HistoryMetric = "cpu" | "ram" | "gpu" | "vram";
export interface HistoryStats { count: number; min: number; max: number; mean: number; p90: number; p95: number; p99: number }
export interface HistoryPoint { time: string; cpu: number | null; ram: number | null; gpu: number | null; vram: number | null }
export interface MetricsHistorySummary {
    ok: true; monitorId: number; hours: number; from: string; to: string;
    capped: boolean; samples: number; firstSample: string | null; lastSample: string | null;
    bucketSeconds: number; percentileMethod: string; basis: string;
    stats: Record<HistoryMetric, HistoryStats | null>; series: HistoryPoint[];
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
 * @returns Samples keyed by monitor id, null where missing
 */
export function fetchLatestMetricsBulk(ids: number[]): Promise<{
    ok: true;
    count: number;
    samples: Record<number, { time: string; metrics: MetricsPayload; cpuPeak10m?: CPUPeak | null } | null>;
}> {
    return request(`/api/v1/monitors/metrics/latest?ids=${ids.join(",")}`);
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
export function fetchApiKeys(): Promise<{ ok: true; count: number; apiKeys: ApiKeySummary[]; availableScopes: string[] }> {
    return request("/api/v1/api-keys");
}

/**
 * Mint a token. The plaintext comes back exactly once.
 */
export function createApiKey(payload: { name: string; scopes?: string | string[]; active?: boolean; expires?: string | null }): Promise<{
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
// Authentication, setup, invites and account administration.
//
// The dashboard signs operators in with a username and password and stores
// the minted bearer token — the same credential shape an agent uses. No
// session cookie, no Socket.IO.
// ---------------------------------------------------------------------------

export interface AuthUser {
    id: string;
    username: string | null;
    name: string;
    banned?: boolean;
}

/**
 * Whether the instance still needs first-run setup.
 */
export function fetchSetupStatus(): Promise<{ ok: true; setupNeeded: boolean }> {
    return request("/api/v1/auth/setup");
}

/**
 * Create the first account. Only works before setup completes.
 */
export function createFirstAccount(payload: { username: string; password: string }): Promise<{ ok: true }> {
    return request("/api/setup", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

export interface LoginResult {
    ok: true;
    token: string;
    user: AuthUser;
}

/**
 * Password login. Mints a full-scope token returned exactly once — the
 * caller persists it via setToken. Throws an ApiError with code
 * "two_factor_required" when the account needs a TOTP code; retry with it.
 */
export function login(payload: { username: string; password: string; totp?: string }): Promise<LoginResult> {
    return request("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

/**
 * The current token's account and scopes.
 */
export function fetchMe(): Promise<{ ok: true; user: AuthUser; scopes: string[] }> {
    return request("/api/v1/auth/me");
}

export interface UserSummary {
    id: string;
    name: string;
    email: string;
    username: string | null;
    createdAt: string;
    banned: boolean;
    isCurrent: boolean;
}

/**
 * List every account.
 */
export function fetchUsers(): Promise<{ ok: true; count: number; users: UserSummary[] }> {
    return request("/api/v1/users");
}

/**
 * Delete an account. Refuses the caller and the last remaining account.
 */
export function deleteUser(id: string): Promise<{ ok: true; deleted: string }> {
    return request(`/api/v1/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Ban or unban an account. A ban drops live sessions immediately.
 */
export function setUserBanned(id: string, banned: boolean): Promise<{ ok: true; id: string; banned: boolean }> {
    return request(`/api/v1/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ banned }),
    });
}

export interface InviteSummary {
    id: number;
    note: string | null;
    createdDate: string;
    expires: string;
    usedAt: string | null;
    status: string;
}

/**
 * List own invite links.
 */
export function fetchInvites(): Promise<{ ok: true; count: number; invites: InviteSummary[] }> {
    return request("/api/v1/invites");
}

/**
 * Mint a single-use invite link. The plaintext token comes back exactly once.
 */
export function createInvite(payload: { note?: string; expiryHours?: number } = {}): Promise<{
    ok: true;
    inviteID: number;
    token: string;
    expires: string;
}> {
    return request("/api/v1/invites", {
        method: "POST",
        body: JSON.stringify(payload),
    });
}

/**
 * Revoke an unused invite.
 */
export function revokeInvite(id: number): Promise<{ ok: true; revoked: number }> {
    return request(`/api/v1/invites/${id}`, { method: "DELETE" });
}

/**
 * Check an invite link without redeeming it.
 */
export function checkInvite(token: string): Promise<{ ok: true; status: string; expires: string; note: string | null }> {
    return request(`/api/v1/auth/invites/${encodeURIComponent(token)}`);
}

/**
 * Redeem an invite, creating the account.
 */
export function redeemInvite(token: string, payload: { username: string; password: string }): Promise<{
    ok: true;
    username: string;
}> {
    return request(`/api/v1/auth/invites/${encodeURIComponent(token)}/redeem`, {
        method: "POST",
        body: JSON.stringify(payload),
    });
}
