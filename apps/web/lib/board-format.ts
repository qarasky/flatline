/**
 * Text for the main board's rows, summary and strip tooltips.
 */

import type { MonitorSummary } from "./monitor-types";
import { formatDuration, type AttentionItem } from "./attention";
import type { StatusKey, Totals } from "./board-model";
import { parseTime, type BucketInfo } from "./heartbeat-strip";

export const STATUS_LABEL: Record<StatusKey, string> = {
    up: "Up",
    down: "Down",
    pending: "Pending",
    maintenance: "Maintenance",
    paused: "Paused",
};

export function formatUptime(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "—";
    }
    // The API returns a 0..1 ratio.
    return `${(value * 100).toFixed(value >= 0.9999 ? 2 : 1)}%`;
}

export function formatPing(value: number | null | undefined): string {
    return value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
}

/** "12s ago", "3m ago"; "—" when unknown. */
export function checkedAgo(lastCheck: string | null | undefined, nowMs: number): string {
    const then = parseTime(lastCheck);
    if (!Number.isFinite(then)) {
        return "—";
    }
    return `${formatDuration(Math.max(0, nowMs - then))} ago`;
}

/**
 * What to show next to the name: the check target for each type.
 *
 * Ping monitors are checked by hostname, and the old schema left a bare
 * "https://" in their url column. Push monitors have no target; their last
 * message is the honest thing.
 */
export function monitorTarget(monitor: Pick<MonitorSummary, "type" | "hostname" | "url" | "lastMessage">): string {
    if (monitor.type === "ping") {
        return monitor.hostname?.trim() || "ICMP";
    }
    const url = monitor.url?.trim();
    if (url && url !== "https://" && url !== "http://") {
        return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    }
    return monitor.lastMessage?.trim() || "—";
}

/** The one-line fleet state for the summary banner. */
export function summarySentence(
    totals: Totals,
    attention: AttentionItem[]
): { text: string; tone: "ok" | "warn" | "bad" | "maint" | "quiet" } {
    if (totals.total === 0) {
        return { text: "No monitors yet", tone: "quiet" };
    }
    // Muted items are an acknowledged outage: they neither count nor turn
    // the sentence red.
    const open = attention.filter((item) => !item.muted);
    const mutedDown = attention.filter((item) => item.muted && item.kind === "down").length;
    const subjects = new Set(open.map((item) => (item.monitorId !== null ? `m${item.monitorId}` : item.key)));
    if (subjects.size > 0) {
        const unlinked = open.some((item) => item.monitorId === null);
        const noun = unlinked ? "item" : "monitor";
        const n = subjects.size;
        return {
            text: `${n} ${noun}${n === 1 ? " needs" : "s need"} attention`,
            tone: totals.down > mutedDown ? "bad" : "warn",
        };
    }
    const mutedSubjects = new Set(attention.map((item) => item.monitorId ?? item.key)).size;
    if (mutedSubjects > 0) {
        return { text: `Nothing new · ${mutedSubjects} muted`, tone: "quiet" };
    }
    const active = totals.total - totals.paused;
    if (active === 0) {
        return { text: "All monitors are paused", tone: "quiet" };
    }
    if (totals.maintenance > 0) {
        return { text: `${totals.maintenance} in maintenance, the rest up`, tone: "maint" };
    }
    return { text: `All ${active} monitor${active === 1 ? "" : "s"} up`, tone: "ok" };
}

/** Time range line for a strip bucket tooltip, in the viewer's locale. */
export function bucketRange(info: BucketInfo, nowMs: number): string {
    const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sameDay = new Date(info.fromMs).toDateString() === new Date(nowMs).toDateString();
    const day = sameDay ? "" : `${new Date(info.fromMs).toLocaleDateString([], { weekday: "short" })} `;
    return `${day}${time(info.fromMs)}–${time(info.toMs)}`;
}

export function bucketSummary(info: BucketInfo): string {
    if (info.status === null) {
        return "No checks";
    }
    const word = info.status === 0 ? "Down" : info.status === 2 ? "Pending" : info.status === 3 ? "Maintenance" : "Up";
    const failed = info.failed > 0 ? `, ${info.failed} failed` : "";
    return `${word} · ${info.beats} check${info.beats === 1 ? "" : "s"}${failed}`;
}
