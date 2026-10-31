import type { HealthSummary, MonitorSummary } from "./monitor-types";

export function healthFromMonitors(monitors: MonitorSummary[]): HealthSummary {
    const health: HealthSummary = {
        total: monitors.length,
        up: 0,
        down: 0,
        pending: 0,
        maintenance: 0,
        paused: 0,
        status: "up",
        downMonitors: [],
    };
    for (const monitor of monitors) {
        if (!monitor.active) {
            health.paused++;
            continue;
        }
        if (monitor.status === 1) {
            health.up++;
        } else if (monitor.status === 0) {
            health.down++;
            health.downMonitors.push({ id: monitor.id, name: monitor.name, url: monitor.url });
        } else if (monitor.status === 3) {
            health.maintenance++;
        } else {
            health.pending++;
        }
    }
    health.status = health.down > 0 ? "down" : "up";
    return health;
}
