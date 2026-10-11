// Fictional, deterministic documentation data. No production API or DB access.
import { createRequire } from "node:module";
const { historySummary } = createRequire(import.meta.url)("../server/metrics-history.js");
export const NOW = Date.parse("2026-10-01T12:00:00Z");
const names = ["edge-north", "edge-south", "app-primary", "app-secondary", "database-01", "worker-pool", "gpu-render", "backup-vault"];
const loads = [18, 12, 42, 31, 28, 94, 68, 4];
const at = offset => new Date(NOW + offset).toISOString();
const base = { active: true, interval: 60, lastCheck: at(-2000), lastMessage: "OK", uptime24h: 1, uptime7d: .9998, uptime30d: .9995, tags: [] };
export const monitors = [
    { ...base, id: 100, name: "Example applications", type: "group", status: 1, url: null, ping: null },
    ...["Website", "Public API", "Checkout", "DNS", "TCP gateway", "Search"].map((name, i) => ({
        ...base, id: 101 + i, parent: 100, name, type: i === 3 ? "dns" : i === 4 ? "port" : "http",
        url: `https://${["www", "api", "checkout", "dns", "gateway", "search"][i]}.example.com`,
        status: i === 2 ? 0 : 1, ping: i === 2 ? null : 24 + i * 17,
        uptime24h: i === 2 ? .987 : 1, lastMessage: i === 2 ? "HTTP 503 — service unavailable" : "200 OK",
    })),
    { ...base, id: 200, name: "Example infrastructure", type: "group", status: 1, url: null, ping: null },
    ...names.map((name, i) => ({ ...base, id: i + 1, parent: 200, name, type: "push", status: i === 7 ? 0 : 1,
        url: null, ping: i === 7 ? null : 2 + i, interval: 180, lastMessage: i === 7 ? "Push heartbeat overdue" : "Agent connected" })),
];
export const samples = Object.fromEntries(names.map((name, i) => [i + 1, {
    time: at(i === 7 ? -240_000 : -1000), cpuPeak10m: { percent: Math.min(100, loads[i] + 16), at: at(-120_000) },
    metrics: {
        v: 1, sampleInterval: 1, host: { hostname: name, os: "Ubuntu 24.04 LTS", uptime: (12 + i * 9) * 86400 },
        cpu: { percent: loads[i], cores: 8, perCore: Array.from({ length: 8 }, (_, core) => Math.min(100, loads[i] + Math.sin(core + i) * 12)), temp: 38 + i * 3 },
        mem: { total: 32 * 2 ** 30, used: (24 + i * 7) / 100 * 32 * 2 ** 30, percent: 24 + i * 7 },
        disk: [{ mount: "/", total: 1024 * 2 ** 30, used: (22 + i * 6) / 100 * 1024 * 2 ** 30, percent: 22 + i * 6 }],
        ...(i === 6 ? { gpu: { available: true, gpus: [{ name: "Example GPU · 16 GB", util: 78, memUsed: 11 * 2 ** 30, memTotal: 16 * 2 ** 30, temp: 64 }] } } : {}),
        docker: Array.from({ length: i === 2 ? 20 : 9 }, (_, c) => ({
            name: ["web", "api", "proxy", "cache", "queue", "jobs", "metrics", "logs", "archive"][c % 9] + (c >= 9 ? `-${Math.floor(c / 9) + 1}` : ""),
            image: "example/service:1", state: i === 2 && c === 0 ? "restarting" : c === 8 ? "exited" : c === 7 ? "created" : "running",
            health: c < 7 ? "healthy" : undefined,
        })),
    },
}]));

export function history(id, hours = 1) {
    const from = at(-hours * 3600_000), to = at(0);
    const rows = Array.from({ length: Math.floor(hours * 120) }, (_, i) => ({
        time: at(-hours * 3600_000 + i * 30_000),
        cpu: Math.min(100, Math.max(0, 38 + 19 * Math.sin(i / 13) + 8 * Math.sin(i / 3) + (i % 43 === 0 ? 25 : 0))),
        ram: 55 + 7 * Math.sin(i / 27), gpu_available: 1,
        gpu: Math.max(0, Math.min(100, 61 + 25 * Math.sin(i / 18))),
        vram_used: 9 + 2 * Math.sin(i / 23), vram_total: 16,
    }));
    return { ok: true, monitorId: id, hours, from, to, capped: false, percentileMethod: "nearest-rank",
        basis: "Synthetic archived snapshots, 30-second cadence", ...historySummary(rows, from, to) };
}
