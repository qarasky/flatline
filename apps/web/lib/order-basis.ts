import type { MonitorSummary } from "@/lib/monitor-types";

/**
 * What the board sorts by. While the order is held (the pointer is over the
 * list, rows are selected or a menu is open), a live status change must not
 * move rows under the operator's hand: known monitors keep the sort keys
 * they had (`status`, `active`, `uptime24h`, read by `buildBoard` through
 * its `basis`) while everything else, names included, is live. New monitors
 * join and deleted ones leave, so the held order never shows a ghost row.
 */
export function orderBasis(
    previous: Map<number, MonitorSummary>,
    monitors: MonitorSummary[],
    hold: boolean
): Map<number, MonitorSummary> {
    if (!hold) {
        return new Map(monitors.map((m) => [m.id, m]));
    }
    return new Map(
        monitors.map((m) => {
            const held = previous.get(m.id);
            return [m.id, held ? { ...m, status: held.status, active: held.active, uptime24h: held.uptime24h } : m];
        })
    );
}
