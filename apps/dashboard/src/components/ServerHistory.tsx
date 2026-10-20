import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchMetricsHistory, type HistoryMetric, type MetricsHistorySummary, type MonitorSummary } from "@/lib/api";
import { historyPath, historyRefreshMs, historyTimeoutMs } from "@/lib/history-chart";
import { percentage } from "@/lib/fleet-presentation";
import { Button } from "@/components/ui/button";

const RANGES = [
    { label: "10m", hours: 1 / 6 },
    { label: "1h", hours: 1 },
    { label: "6h", hours: 6 },
    { label: "24h", hours: 24 },
    { label: "7d", hours: 168 },
    { label: "30d", hours: 720 },
    { label: "1y", hours: 8760 },
];
const CHARTS: { key: HistoryMetric; label: string; color: string }[] = [
    { key: "cpu", label: "Total CPU", color: "#e0d9c9" },
    { key: "ram", label: "RAM", color: "#9eb8cd" },
    { key: "gpu", label: "GPU · first device", color: "#b5c8a1" },
    { key: "vram", label: "VRAM · first device", color: "#c4acd2" },
];

function HistoryChart({
    data,
    metric,
    label,
    color,
}: {
    data: MetricsHistorySummary;
    metric: HistoryMetric;
    label: string;
    color: string;
}) {
    const [hover, setHover] = useState<number | null>(null);
    const stats = data.stats[metric];
    const path = useMemo(
        () => historyPath(data.series, metric, data.from, data.to, data.bucketSeconds),
        [data, metric]
    );
    const point = hover === null ? null : data.series[hover];
    return (
        <section className="history-chart" style={{ "--history-line": color } as React.CSSProperties}>
            <header className="flex items-baseline justify-between gap-3">
                <h3>{label}</h3>
                <span className="tnum text-xs text-quiet">
                    {stats ? `${stats.count.toLocaleString()} samples` : "No readings"}
                </span>
            </header>
            {stats ? (
                <>
                    <dl className="history-stats tnum">
                        {(
                            [
                                ["Mean", stats.mean],
                                ["Peak", stats.max],
                                ["p90", stats.p90],
                                ["p95", stats.p95],
                                ["p99", stats.p99],
                            ] as const
                        ).map(([name, value]) => (
                            <div
                                key={name}
                                title={
                                    name.startsWith("p")
                                        ? `${name.slice(1)}% of archived readings are at or below this load`
                                        : undefined
                                }
                            >
                                <dt>{name}</dt>
                                <dd>{percentage(value)}</dd>
                            </div>
                        ))}
                    </dl>
                    <svg
                        viewBox="0 0 600 160"
                        role="img"
                        aria-label={`${label} history: mean ${percentage(stats.mean)}, p95 ${percentage(stats.p95)}, peak ${percentage(stats.max)}`}
                        onPointerLeave={() => setHover(null)}
                        onPointerMove={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            const fraction = Math.max(
                                0,
                                Math.min(1, (((event.clientX - rect.left) / rect.width) * 600 - 28) / 544)
                            );
                            const time =
                                Date.parse(data.from) + fraction * (Date.parse(data.to) - Date.parse(data.from));
                            let best = -1,
                                distance = Infinity;
                            data.series.forEach((sample, i) => {
                                const d = Math.abs(Date.parse(sample.time) - time);
                                if (sample[metric] !== null && d < distance) {
                                    best = i;
                                    distance = d;
                                }
                            });
                            setHover(best < 0 ? null : best);
                        }}
                    >
                        {[0, 25, 50, 75, 100].map((value) => (
                            <g key={value}>
                                <line
                                    x1="28"
                                    x2="572"
                                    y1={142 - value * 1.26}
                                    y2={142 - value * 1.26}
                                    stroke="#ffffff12"
                                />
                                <text x="2" y={146 - value * 1.26} fill="#8b8681" fontSize="10">
                                    {value}
                                </text>
                            </g>
                        ))}
                        <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                        {data.series.filter((p) => p[metric] !== null).length === 1 ? (
                            <circle
                                cx={
                                    28 +
                                    ((Date.parse(data.series.find((p) => p[metric] !== null)!.time) -
                                        Date.parse(data.from)) /
                                        (Date.parse(data.to) - Date.parse(data.from))) *
                                        544
                                }
                                cy={142 - stats.mean * 1.26}
                                r="3"
                                fill={color}
                            />
                        ) : null}
                        {point && point[metric] !== null ? (
                            <circle
                                cx={
                                    28 +
                                    ((Date.parse(point.time) - Date.parse(data.from)) /
                                        (Date.parse(data.to) - Date.parse(data.from))) *
                                        544
                                }
                                cy={142 - point[metric] * 1.26}
                                r="4"
                                fill={color}
                            />
                        ) : null}
                    </svg>
                    <div className="history-axis">
                        <span>
                            {new Date(data.from).toLocaleString([], {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                            })}
                        </span>
                        <span>
                            {new Date(data.to).toLocaleString([], {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                            })}
                        </span>
                    </div>
                    <p className="history-hover tnum">
                        {point
                            ? `${new Date(point.time).toLocaleString()} · ${percentage(point[metric] ?? undefined)} bucket average`
                            : "Hover to inspect a reading"}
                    </p>
                </>
            ) : (
                <p className="history-no-data">No {label.toLowerCase()} samples in this range.</p>
            )}
        </section>
    );
}

export const ServerHistory = memo(function ServerHistory({
    monitor,
    onClose,
}: {
    monitor: MonitorSummary;
    onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [hours, setHours] = useState(1);
    const [data, setData] = useState<MetricsHistorySummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const element = dialog.current;
        const previous = document.activeElement as HTMLElement | null;
        element?.showModal();
        return () => {
            element?.close();
            previous?.focus();
        };
    }, []);

    useEffect(() => {
        let alive = true,
            busy = false;
        // Aborts whatever is in flight when the range changes or the dialog
        // closes; each request also gets its own deadline below.
        const controller = new AbortController();
        setData(null);
        setLoading(true);
        setError(null);
        async function load() {
            if (busy) {
                return;
            }
            busy = true;
            const request = new AbortController();
            const abort = () => request.abort();
            controller.signal.addEventListener("abort", abort, { once: true });
            const deadline = window.setTimeout(abort, historyTimeoutMs(hours));
            try {
                const result = await fetchMetricsHistory(monitor.id, hours, request.signal);
                if (alive) {
                    setData(result);
                    setError(null);
                }
            } catch (e) {
                if (alive) {
                    setError(
                        request.signal.aborted
                            ? "History request timed out; retrying on the next refresh."
                            : e instanceof Error
                              ? e.message
                              : "Could not load history"
                    );
                }
            } finally {
                window.clearTimeout(deadline);
                controller.signal.removeEventListener("abort", abort);
                busy = false;
                if (alive) {
                    setLoading(false);
                }
            }
        }
        void load();
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                void load();
            }
        }, historyRefreshMs(hours));
        return () => {
            alive = false;
            controller.abort();
            window.clearInterval(timer);
        };
    }, [monitor.id, hours]);

    return createPortal(
        <dialog
            ref={dialog}
            className="history-dialog"
            aria-labelledby="history-title"
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="history-panel">
                <header className="history-heading">
                    <div>
                        <p className="fleet-label">Server load history</p>
                        <h2 id="history-title">{monitor.name}</h2>
                    </div>
                    <Button onClick={onClose} autoFocus aria-label="Close load history">
                        Close · Esc
                    </Button>
                </header>
                <div className="history-controls" role="group" aria-label="History time range">
                    {RANGES.map((range) => (
                        <Button
                            key={range.label}
                            aria-pressed={hours === range.hours}
                            onClick={() => setHours(range.hours)}
                        >
                            {range.label}
                        </Button>
                    ))}
                    <span className="text-xs text-quiet">Refreshes every 30s</span>
                </div>
                <p className="history-note">
                    {data ? `${data.basis}. ` : "Percentiles use archived snapshots (normally every 30s). "}p95 means
                    95% of readings were at or below that load. Charts show bucket averages; gaps are not zeroes.
                </p>
                {error ? (
                    <p className="text-warn text-sm" role="alert">
                        {error}
                    </p>
                ) : null}
                {loading ? (
                    <p className="history-no-data" role="status">
                        Loading history…
                    </p>
                ) : data?.samples === 0 ? (
                    <p className="history-no-data">
                        No archived readings yet in this range. New agents archive their first sample immediately.
                    </p>
                ) : data ? (
                    <>
                        {data.capped ? (
                            <p className="text-warn text-sm">
                                Window exceeds the safety limit. These statistics cover only the newest 50,000 samples.
                            </p>
                        ) : null}
                        <p className="history-note tnum">
                            {data.samples.toLocaleString()} archived snapshots · {Math.round(data.bucketSeconds)}s chart
                            buckets · available from{" "}
                            {data.firstSample ? new Date(data.firstSample).toLocaleString() : "—"}
                        </p>
                        <div className="history-charts">
                            {CHARTS.map((chart) => (
                                <HistoryChart
                                    key={chart.key}
                                    data={data}
                                    metric={chart.key}
                                    label={chart.label}
                                    color={chart.color}
                                />
                            ))}
                        </div>
                    </>
                ) : null}
            </div>
        </dialog>,
        document.body
    );
});
