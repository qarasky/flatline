"use client";

import {
    cn,
    EmptyState,
    Input,
    PageBody,
    Select,
    Table,
    TableBody,
    TableCell,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TableRowHeader,
} from "@qarasky/kore-ui";
import { Search, Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { useBoardData } from "@/components/board/board-data";
import { PausedBanner } from "@/components/board/paused-banner";
import { UsageMeter } from "@/components/fleet/metric-bar";
import { ProviderLogo } from "@/components/fleet/provider-logo";
import { StatusDot, statusTone } from "@/components/monitors/status-dot";
import { useClock } from "@/hooks/use-clock";
import { STATUS_LABEL } from "@/lib/board-format";
import { statusKeyOf, statusRank } from "@/lib/board-model";
import type { MonitorSummary } from "@/lib/monitor-types";
import { isCovered } from "@/lib/mute";
import { serverRow, type ServerRow } from "@/lib/server-row";

import { useFleetMetrics } from "./use-fleet-metrics";

type SortKey = "worst" | "name" | "cpu" | "ram" | "disk";
const SORTS: { value: SortKey; label: string }[] = [
    { value: "worst", label: "Worst first" },
    { value: "name", label: "Name" },
    { value: "cpu", label: "CPU" },
    { value: "ram", label: "RAM" },
    { value: "disk", label: "Disk" },
];

function Row({ monitor, row, loaded }: { monitor: MonitorSummary; row: ServerRow; loaded: boolean }) {
    const router = useRouter();
    const status = statusKeyOf(monitor);
    const muted = status === "down" && isCovered(monitor);
    const href = `/servers/${monitor.id}`;
    return (
        <TableRow
            interactive
            data-server-id={monitor.id}
            onClick={(event) => {
                // The name is the real link; the rest of the row is a mouse shortcut to it.
                if (!(event.target as HTMLElement).closest("a")) {
                    router.push(href);
                }
            }}
        >
            <TableRowHeader className="max-w-72">
                <span className="flex min-w-0 items-center gap-2.5">
                    <StatusDot status={status} muted={muted} />
                    <ProviderLogo provider={monitor.provider} />
                    <Link href={href} className="truncate font-medium hover:underline">
                        {monitor.name}
                    </Link>
                </span>
            </TableRowHeader>
            <TableCell
                className={cn("text-sub whitespace-nowrap", status === "up" ? "text-muted" : statusTone(status))}
            >
                {muted ? "Down · muted" : STATUS_LABEL[status]}
            </TableCell>
            {row.freshness === "none" ? (
                <TableCell muted colSpan={3} className="text-sub">
                    {loaded ? "No metrics yet" : "Loading metrics…"}
                </TableCell>
            ) : (
                <>
                    <TableCell className="min-w-28">
                        <UsageMeter label="CPU" percent={row.cpu} hideLabel />
                    </TableCell>
                    <TableCell className="min-w-28">
                        <UsageMeter label="RAM" percent={row.ram} hideLabel />
                    </TableCell>
                    <TableCell className="min-w-28">
                        <UsageMeter label="Disk" percent={row.disk} hideLabel />
                    </TableCell>
                </>
            )}
            <TableCell align="right" className="text-meta">
                <span className={cn("block truncate", row.freshness === "stale" ? "text-status-warn" : "text-muted")}>
                    {row.freshness === "none" ? "—" : row.ageText}
                </span>
                {row.agentVersion ? <span className="block truncate text-muted">agent {row.agentVersion}</span> : null}
            </TableCell>
        </TableRow>
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
        return (
            <PageBody width="full">
                <p className="text-muted">Loading…</p>
            </PageBody>
        );
    }
    return (
        <section aria-label="Servers" className="flex min-h-0 flex-1 flex-col">
            <PausedBanner />
            <PageBody width="full" className="grid gap-4">
                {servers.length === 0 ? (
                    <EmptyState
                        icon={<Server />}
                        title="No servers yet"
                        description="A server is a push monitor whose host runs the KoreMonitor agent."
                    />
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-meta text-muted tnum">
                                {servers.length} server{servers.length === 1 ? "" : "s"}
                            </span>
                            <Input
                                type="search"
                                size="sm"
                                leadingIcon={<Search />}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search servers"
                                aria-label="Search servers"
                                className="ml-auto w-56"
                            />
                            <Select
                                size="sm"
                                aria-label="Sort"
                                value={sort}
                                onValueChange={setSort}
                                options={SORTS}
                                className="w-40"
                            />
                        </div>
                        {failed ? (
                            <p role="status" className="text-meta text-warning">
                                Couldn&apos;t load the latest metrics for some servers; their numbers may be old.
                            </p>
                        ) : null}
                        <Table caption="Servers">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Server</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>CPU</TableHead>
                                    <TableHead>RAM</TableHead>
                                    <TableHead>Disk</TableHead>
                                    <TableHead align="right">Updated</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.length === 0 ? (
                                    <TableEmpty colSpan={6}>No servers match “{query.trim()}”.</TableEmpty>
                                ) : (
                                    rows.map(({ monitor, row }) => (
                                        <Row key={monitor.id} monitor={monitor} row={row} loaded={loaded} />
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </>
                )}
            </PageBody>
        </section>
    );
}
