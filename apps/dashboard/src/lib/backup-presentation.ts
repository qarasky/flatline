/**
 * Backup presentation rules: health labels and the distinction between a
 * transferred bundle, an archive verification and an actual restore test.
 * Transfer success is never called a restore.
 */

import type { BackupAgentSummary, BackupRunSummary } from "./api.ts";

export type BackupTone = "up" | "down" | "degraded" | "neutral";

/**
 * The agent's health label and the badge tone.
 * @param agent Backup agent summary
 */
export function backupHealth(agent: BackupAgentSummary): { label: string; tone: BackupTone } {
    switch (agent.health) {
        case "disabled":
            return { label: "Disabled", tone: "neutral" };
        case "pending":
            return { label: "Pending", tone: "degraded" };
        case "healthy":
            return { label: "Healthy", tone: "up" };
        case "failed":
            return { label: "Failed", tone: "down" };
        case "overdue":
            return { label: "Overdue", tone: "down" };
        default:
            return { label: "Unknown", tone: "neutral" };
    }
}

/**
 * Verification state for one run. A completed upload is only
 * "Transfer verified"; restore-tested requires an operator restore result.
 * @param run Backup run summary
 */
export function verificationLabel(run: BackupRunSummary): string {
    if (run.restoreVerification) {
        return run.restoreVerification.status === "passed" ? "Restore tested" : "Restore failed";
    }
    if (run.archiveVerification) {
        return run.archiveVerification.status === "passed" ? "Transfer verified" : "Transfer failed";
    }
    return run.status === "completed" ? "Transfer verified" : "Not completed";
}

/**
 * Agent-level restore result. It points at the run that was actually tested,
 * even when a newer untested backup exists.
 * @param agent Backup agent summary
 */
export function restoreLabel(agent: BackupAgentSummary): string {
    const verification = agent.latestRestoreVerification;
    if (!verification) {
        return "Not restore-tested";
    }
    return verification.status === "passed" ? "Restore tested" : "Restore failed";
}

/**
 * Duration of the source export, derived from manifest times.
 * @param run Backup run summary
 */
export function backupDuration(run: BackupRunSummary | null): string {
    if (!run?.exportFinishedAt) {
        return "—";
    }
    const started = Date.parse(run.exportStartedAt);
    const finished = Date.parse(run.exportFinishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
        return "—";
    }
    const seconds = Math.round((finished - started) / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

/**
 * Human source summary. The numbers are agent-reported, not independently
 * verified.
 * @param run Backup run summary
 */
export function backupSourceSummary(run: BackupRunSummary | null): string {
    if (!run?.sourceSummary) {
        return "—";
    }
    return `${run.sourceSummary.databaseCount} DB · ${run.sourceSummary.objectCount} objects · ${formatBytes(
        run.sourceSummary.sourceBytes
    )}`;
}

/** Local byte formatter; mirrors the fleet presentation helper without a dependency cycle. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "—";
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Format an RFC3339 timestamp for the dense detail view.
 * @param value Timestamp
 */
export function backupTime(value: string | null): string {
    if (!value) {
        return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toISOString().slice(0, 16).replace("T", " ");
}
