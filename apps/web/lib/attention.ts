/**
 * "Needs attention": what is wrong right now, derived from data the board
 * already holds (roster, 24 h strips, and two cheap bulk reads for agent and
 * backup health).
 */

import type { BackupAgentSummary, MonitorSummary } from "./monitor-types";
import { isFlapping, parseTime, statusSince, type Strip } from "./heartbeat-strip";
import { isCovered } from "./mute";

export type AttentionKind = "down" | "pending" | "flapping" | "stale" | "agent" | "backup";

export interface AttentionItem {
    key: string;
    kind: AttentionKind;
    /** The monitor to open; null for a backup agent that is not linked to one. */
    monitorId: number | null;
    name: string;
    /** What is wrong. */
    title: string;
    /** For how long, or other context. */
    detail: string;
    /** When it started, epoch ms, when known. */
    sinceMs: number | null;
    /** Part of an acknowledged outage: listed after everything else. */
    muted: boolean;
}

/** A push monitor is stale after this many intervals without a beat. */
export const STALE_FACTOR = 3;

const KIND_ORDER: AttentionKind[] = ["down", "pending", "flapping", "stale", "agent", "backup"];

/** "45s", "12m", "2h 10m", "3d 4h". */
export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const rest = minutes % 60;
        return rest ? `${hours}h ${rest}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days}d ${rest}h` : `${days}d`;
}

export interface AttentionInput {
    monitors: MonitorSummary[];
    strips: Map<number, Strip>;
    nowMs: number;
    /** Exact times of status flips seen live (more precise than bucket starts). */
    changedAt?: Map<number, number>;
    /** Outstanding agent warning text per monitor. */
    agentWarnings?: Map<number, string>;
    backups?: BackupAgentSummary[];
}

function since(
    monitor: MonitorSummary,
    status: number,
    input: AttentionInput
): { ms: number; atLeast: boolean } | null {
    const live = input.changedAt?.get(monitor.id);
    if (live !== undefined) {
        return { ms: live, atLeast: false };
    }
    const strip = input.strips.get(monitor.id);
    const run = strip ? statusSince(strip, status) : null;
    return run ? { ms: run.sinceMs, atLeast: run.atLeast } : null;
}

function duration(run: { ms: number; atLeast: boolean } | null, nowMs: number): string | null {
    if (!run) {
        return null;
    }
    return `${run.atLeast ? "at least " : ""}${formatDuration(nowMs - run.ms)}`;
}

/** Attention items, worst first. At most one status item per monitor. */
export function deriveAttention(input: AttentionInput): AttentionItem[] {
    const items: AttentionItem[] = [];
    const { nowMs } = input;

    for (const monitor of input.monitors) {
        if (monitor.type === "group" || !monitor.active) {
            continue;
        }
        const strip = input.strips.get(monitor.id);
        const base = { monitorId: monitor.id, name: monitor.name, muted: false };
        const lastCheckMs = parseTime(monitor.lastCheck);

        if (monitor.status === 0) {
            const run = since(monitor, 0, input);
            const text = duration(run, nowMs);
            items.push({
                ...base,
                key: `down:${monitor.id}`,
                kind: "down",
                muted: isCovered(monitor),
                title: "Down",
                detail: text ? `for ${text}` : monitor.lastMessage?.trim() || "no detail",
                sinceMs: run?.ms ?? null,
            });
        } else if (monitor.status === 2) {
            const run = since(monitor, 2, input);
            const text = duration(run, nowMs);
            items.push({
                ...base,
                key: `pending:${monitor.id}`,
                kind: "pending",
                title: "Retrying",
                detail: text ? `for ${text}` : "checking again",
                sinceMs: run?.ms ?? null,
            });
        } else if (isFlapping(strip)) {
            items.push({
                ...base,
                key: `flapping:${monitor.id}`,
                kind: "flapping",
                title: "Flapping",
                detail: "several status changes in the last 6 h",
                sinceMs: null,
            });
        } else if (
            monitor.type === "push" &&
            monitor.interval > 0 &&
            Number.isFinite(lastCheckMs) &&
            nowMs - lastCheckMs > monitor.interval * 1000 * STALE_FACTOR
        ) {
            items.push({
                ...base,
                key: `stale:${monitor.id}`,
                kind: "stale",
                // A muted host is expected to stop pushing.
                muted: isCovered(monitor),
                title: "No push",
                detail: `last beat ${formatDuration(nowMs - lastCheckMs)} ago`,
                sinceMs: lastCheckMs,
            });
        }
    }

    const names = new Map(input.monitors.map((m) => [m.id, m.name]));
    for (const [id, text] of input.agentWarnings ?? []) {
        const monitor = input.monitors.find((m) => m.id === id);
        if (!monitor || !monitor.active) {
            continue;
        }
        items.push({
            key: `agent:${id}`,
            kind: "agent",
            monitorId: id,
            name: names.get(id) ?? `Monitor ${id}`,
            title: "Agent warning",
            detail: text.replace(/^Agent:\s*/, ""),
            sinceMs: null,
            muted: false,
        });
    }

    for (const agent of input.backups ?? []) {
        if (!agent.enabled || (agent.health !== "failed" && agent.health !== "overdue")) {
            continue;
        }
        items.push({
            key: `backup:${agent.id}`,
            kind: "backup",
            monitorId: agent.monitorId,
            name: agent.name,
            title: agent.health === "failed" ? "Backup failed" : "Backup overdue",
            detail: agent.lastErrorCode ? agent.lastErrorCode : "check the backup agent",
            sinceMs: null,
            // A muted host's backups are expected to fall behind.
            muted: isCovered(input.monitors.find((m) => m.id === agent.monitorId)),
        });
    }

    return items.sort(
        (a, b) =>
            Number(a.muted) - Number(b.muted) ||
            KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
            (a.sinceMs ?? Infinity) - (b.sinceMs ?? Infinity) ||
            a.name.localeCompare(b.name)
    );
}

/** Items that are not part of an acknowledged outage. */
export function unmutedCount(items: AttentionItem[]): number {
    return items.filter((item) => !item.muted).length;
}

/** Monitors with at least one attention item (the "needs attention" preset). */
export function attentionMonitorIds(items: AttentionItem[]): Set<number> {
    const ids = new Set<number>();
    for (const item of items) {
        if (item.monitorId !== null) {
            ids.add(item.monitorId);
        }
    }
    return ids;
}
