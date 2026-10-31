"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { PausedBanner } from "@/components/board/paused-banner";
import { UsageBar } from "@/components/fleet/metric-bar";
import { ProviderLogo } from "@/components/fleet/provider-logo";
import { StatusDot, statusTone } from "@/components/monitors/status-dot";
import { Input } from "@/components/ui/input";
import { useClock } from "@/hooks/use-clock";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { STATUS_LABEL } from "@/lib/board-format";
import { statusKeyOf, statusRank } from "@/lib/board-model";
import type { MonitorSummary } from "@/lib/monitor-types";
import { isCovered } from "@/lib/mute";
import { serverRow, type ServerRow } from "@/lib/server-row";
import { cn } from "@/lib/utils";

import { useFleetMetrics } from "./use-fleet-metrics";

type SortKey = "worst" | "name" | "cpu" | "ram" | "disk";
const SORTS: { key: SortKey; label: string }[] = [
    { key: "worst", label: "Worst first" },
    { key: "name", label: "Name" },
    { key: "cpu", label: "CPU" },
    { key: "ram", label: "RAM" },
    { key: "disk", label: "Disk" },
];

function Meter({ label, value }: { label: string; value: number | null }) {
    return (
        <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="tnum">{value === null ? "—" : `${value.toFixed(value < 10 ? 1 : 0)}%`}</span>
            </div>
            <div className="mt-1">
                <UsageBar percent={value ?? undefined} label={label} />
            </div>
        </div>
    );
}

function Row({ monitor, row, loaded }: { monitor: MonitorSummary; row: ServerRow; loaded: boolean }) {
    const status = statusKeyOf(monitor);
    const muted = status === "down" && isCovered(monitor);
    return (
        <li>
            <Link
                href={`/servers/${monitor.id}`}
                data-server-id={monitor.id}
                className="hover:bg-accent grid grid-cols-[12px_minmax(0,1.4fr)_88px_repeat(3,minmax(90px,1fr))_minmax(150px,0.9fr)] items-center gap-4 border-b px-4 py-2.5"
            >
                <StatusDot status={status} muted={muted} />
                <span className="flex min-w-0 items-center gap-2 font-medium">
                    <ProviderLogo provider={monitor.provider} />
                    <span className="truncate">{monitor.name}</span>
                </span>
                <span className={cn("text-xs", status === "up" ? "text-muted-foreground" : statusTone(status))}>
                    {muted ? "Down · muted" : STATUS_LABEL[status]}
                </span>
                {row.freshness === "none" ? (
                    <span className="text-muted-foreground col-span-3 text-xs">
                        {loaded ? "No metrics yet" : "Loading metrics…"}
                    </span>
                ) : (
                    <>
                        <Meter label="CPU" value={row.cpu} />
                        <Meter label="RAM" value={row.ram} />
                        <Meter label="Disk" value={row.disk} />
                    </>
                )}
                <span className="min-w-0 text-right text-xs">
                    <span
                        className={cn(
                            "block truncate",
                            row.freshness === "stale" ? "text-warn" : "text-muted-foreground"
                        )}
                    >
                        {row.freshness === "none" ? "—" : row.ageText}
                    </span>
                    {row.agentVersion ? (
                        <span className="text-muted-foreground block truncate tnum">agent {row.agentVersion}</span>
                    ) : null}
                </span>
            </Link>
        </li>
    );
}

/**
 * Every server (push monitors that report metrics) with live CPU, RAM and
 * fullest-disk use, the agent version and how fresh the numbers are.
 */
export function ServersList() {
    const { monitors, rosterLoaded } = useBoardData();
    // Freshness keeps counting even while Monitors' Pause holds the roster.
    const now = useClock(1000);
    const servers = useMemo(() => monitors.filter((m) => m.type === "push"), [monitors]);
    const { samples, loaded, failed } = useFleetMetrics(useMemo(() => servers.map((s) => s.id), [servers]));
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SortKey>("worst");

    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const shown = servers
            .filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.provider ?? "").includes(needle))
            .map((monitor) => ({ monitor, row: serverRow(monitor, samples.get(monitor.id), now) }));
        const by = (value: (r: ServerRow) => number | null) => (a: (typeof shown)[number], b: (typeof shown)[number]) =>
            (value(b.row) ?? -1) - (value(a.row) ?? -1);
        const byName = (a: (typeof shown)[number], b: (typeof shown)[number]) =>
            a.monitor.name.localeCompare(b.monitor.name);
        switch (sort) {
            case "name":
                return shown.sort(byName);
            case "cpu":
                return shown.sort(by((r) => r.cpu));
            case "ram":
                return shown.sort(by((r) => r.ram));
            case "disk":
                return shown.sort(by((r) => r.disk));
            default:
                return shown.sort(
                    (a, b) =>
                        statusRank(statusKeyOf(a.monitor)) - statusRank(statusKeyOf(b.monitor)) ||
                        Number(b.row.freshness === "stale") - Number(a.row.freshness === "stale") ||
                        byName(a, b)
                );
        }
    }, [servers, samples, now, query, sort]);

    if (!rosterLoaded) {
        return <p className="text-muted-foreground p-6">Loading…</p>;
    }
    return (
        <section aria-label="Servers" className="flex flex-1 flex-col">
            <PausedBanner />
            {failed ? (
                <p role="status" className="text-warn border-b px-4 py-1.5 text-xs">
                    Could not load the latest metrics for some servers; their numbers may be old.
                </p>
            ) : null}
            <div className="flex min-h-11 items-center gap-2 border-b px-4 py-2">
                <span className="text-muted-foreground text-xs tnum">
                    {servers.length} server{servers.length === 1 ? "" : "s"}
                </span>
                <div className="relative ml-auto">
                    <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                    <Input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search servers"
                        aria-label="Search servers"
                        className="h-8 w-56 pl-8"
                    />
                </div>
                <NativeSelect
                    size="sm"
                    aria-label="Sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                >
                    {SORTS.map((s) => (
                        <NativeSelectOption key={s.key} value={s.key}>
                            {s.label}
                        </NativeSelectOption>
                    ))}
                </NativeSelect>
            </div>
            {servers.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-10">
                    <p className="text-muted-foreground max-w-sm text-center">
                        No servers yet. A server is a push monitor whose host runs the Flatline agent.
                    </p>
                </div>
            ) : (
                <ul>
                    {rows.map(({ monitor, row }) => (
                        <Row key={monitor.id} monitor={monitor} row={row} loaded={loaded} />
                    ))}
                </ul>
            )}
        </section>
    );
}
