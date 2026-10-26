/**
 * Mutes: an acknowledged outage. The server keeps each mute and says, per
 * monitor, which subjects cover it (`mutedBy`); the board only decides how a
 * card or row looks from that.
 */

import type { MonitorSummary, ResolvedMonitorLink } from "./api";

/** Whether some active mute covers the monitor. An older backend sends no field: not muted. */
export function isCovered(monitor: Pick<MonitorSummary, "mutedBy"> | undefined): boolean {
    return (monitor?.mutedBy?.length ?? 0) > 0;
}

/** Ids of every covered monitor in a listing. */
export function coveredIds(monitors: Pick<MonitorSummary, "id" | "mutedBy">[]): Set<number> {
    return new Set(monitors.filter((m) => isCovered(m)).map((m) => m.id));
}

export interface CardMute {
    /** The card is red and every down monitor on it is covered: draw it dark red. */
    muted: boolean;
    /** Muted, and the host itself is one of the covered down monitors. */
    hostMuted: boolean;
    /** When the server's own mute was set, if it has one. */
    since: string | null;
    /** Covered down monitors, host first: what the card's Unmute clears. */
    coveredDown: number[];
}

/** How a server card reads its mute state from the host and its website links. */
export function cardMute(
    monitor: Pick<MonitorSummary, "id" | "status" | "mute">,
    links: Pick<ResolvedMonitorLink, "id" | "status">[],
    covered: ReadonlySet<number>
): CardMute {
    const down = [
        ...(monitor.status === 0 ? [monitor.id] : []),
        ...links.filter((l) => l.status === 0).map((l) => l.id),
    ];
    const muted = down.length > 0 && down.every((id) => covered.has(id));
    return {
        muted,
        hostMuted: muted && monitor.status === 0,
        since: monitor.mute?.mutedAt ?? null,
        coveredDown: down.filter((id) => covered.has(id)),
    };
}
