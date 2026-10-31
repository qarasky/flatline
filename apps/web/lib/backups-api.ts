/**
 * Backup agent and run calls (ported from the old dashboard's `api.ts`, plus
 * the agent management the old UI never had). Built on {@link api}: the
 * session cookie authenticates, writes carry the CSRF header, and no
 * credential ever enters a URL.
 */

import { api } from "@/lib/api";
import type { BackupAgentSummary, BackupRunSummary } from "@/lib/monitor-types";

/** One page of backup agents, optionally only those linked to a monitor. */
export function fetchBackupAgents(
    monitorId?: number,
    signal?: AbortSignal
): Promise<{ ok: true; agents: BackupAgentSummary[]; nextCursor: string | null }> {
    const suffix = monitorId === undefined ? "" : `?monitorId=${encodeURIComponent(String(monitorId))}`;
    return api(`/api/v1/backup-agents${suffix}`, { signal });
}

/** Newest-first run history for one agent. */
export function fetchBackupRuns(
    agentId: string,
    signal?: AbortSignal
): Promise<{ ok: true; runs: BackupRunSummary[]; nextCursor: string | null }> {
    return api(`/api/v1/backup-agents/${encodeURIComponent(agentId)}/runs`, { signal });
}

/**
 * A single-use URL for one completed run's bundle (about two minutes, consumed
 * by the first GET), so the browser streams it to disk with a plain navigation.
 */
export async function backupDownloadUrl(runId: string, signal?: AbortSignal): Promise<string> {
    const body = await api<{ url: string }>(`/api/v1/backup-runs/${encodeURIComponent(runId)}/download-ticket`, {
        method: "POST",
        signal,
    });
    return body.url;
}

/** Start the browser's download of a run's bundle under its proper name. */
export async function downloadBackupRun(runId: string, fileName: string): Promise<void> {
    const url = await backupDownloadUrl(runId);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

/** A freshly issued backup-agent credential: shown once, never stored. */
export interface IssuedBackupToken {
    agent: BackupAgentSummary;
    token: string;
}

/** Register an agent; its token comes back exactly once. */
export function createBackupAgent(body: { name: string; monitorId?: number | null }): Promise<IssuedBackupToken> {
    return api("/api/v1/backup-agents", { method: "POST", body });
}

export interface BackupAgentPatch {
    name?: string;
    /** null unlinks the agent from its server. */
    monitorId?: number | null;
    enabled?: boolean;
    intervalSeconds?: number;
    retentionCount?: number;
}

export function updateBackupAgent(
    id: string,
    patch: BackupAgentPatch
): Promise<{ ok: true; agent: BackupAgentSummary }> {
    return api(`/api/v1/backup-agents/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}

/** A new credential for the agent; the old one stops working at once. */
export function rotateBackupToken(id: string): Promise<IssuedBackupToken> {
    return api(`/api/v1/backup-agents/${encodeURIComponent(id)}/rotate-token`, { method: "POST" });
}

/** Disable the agent's credential until it is rotated. */
export function revokeBackupToken(id: string): Promise<{ ok: true; agent: BackupAgentSummary }> {
    return api(`/api/v1/backup-agents/${encodeURIComponent(id)}/revoke-token`, { method: "POST" });
}

export interface VerificationInput {
    kind: "archive" | "restore";
    status: "passed" | "failed";
    /** When the check was done, ISO 8601. */
    checkedAt: string;
    summary: string;
}

/** Record an operator's archive or restore verification of a run. */
export function recordVerification(
    runId: string,
    body: VerificationInput
): Promise<{ ok: true; run: BackupRunSummary }> {
    return api(`/api/v1/backup-runs/${encodeURIComponent(runId)}/verification`, { method: "POST", body });
}
