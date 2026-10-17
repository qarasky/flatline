import { cn } from "@/lib/utils";

export type BarTone = "ok" | "warn" | "bad" | "muted";

/**
 * Severity bucket for a 0–100 percentage.
 *
 * Thresholds are deliberately conservative: a busy box is not a problem until
 * it is, and a board that cries wolf at 60% gets ignored at 95%.
 * @param percent Usage percentage
 * @returns Tone to render
 */
export function usageTone(percent: number | undefined): BarTone {
    if (percent === undefined || !Number.isFinite(percent)) {
        return "muted";
    }
    if (percent >= 90) {
        return "bad";
    }
    if (percent >= 75) {
        return "warn";
    }
    return "ok";
}

const FILL: Record<BarTone, string> = {
    ok: "bg-muted",
    warn: "bg-warn",
    bad: "bg-bad",
    muted: "bg-quiet",
};

/**
 * A bare horizontal usage track: label and number belong to the caller.
 *
 * Same contract as MetricBar — the number is printed by the caller, the fill
 * is decoration on top of it, never the only signal. RAM and Disk each render
 * their figure on their own line above one of these.
 */
export function UsageBar({ percent, tone, label }: { percent: number | undefined; tone?: BarTone; label?: string }) {
    const safe = percent === undefined || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent));
    const resolved = tone ?? usageTone(percent);
    const text = safe === null ? "unknown" : `${safe.toFixed(safe < 10 ? 1 : 0)}%`;

    return (
        <div className="fleet-meter-track" role="img" aria-label={label ? `${label}: ${text}` : text} title={text}>
            <div
                className={cn("fleet-meter-fill transition-[width] duration-300 motion-reduce:transition-none", FILL[resolved])}
                style={{ width: safe === null ? "0%" : `${safe}%` }}
            />
        </div>
    );
}

/**
 * A labelled usage bar: label, the number, and a proportional fill.
 *
 * The percentage is always printed next to the bar, never conveyed by colour
 * or width alone — width is hard to judge and colour is unreliable for a
 * colourblind operator. The fill is decoration on top of the number.
 */
export function MetricBar({
    label,
    percent,
    detail,
    tone,
}: {
    label: string;
    percent: number | undefined;
    detail?: string;
    tone?: BarTone;
}) {
    const safe = percent === undefined || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent));
    const resolved = tone ?? usageTone(percent ?? undefined);

    return (
        <div className="metric-bar">
            <div className="flex items-baseline justify-between gap-2">
                <span className="metric-label min-w-0 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase" title={label}>{label}</span>
                <span className="metric-value tnum text-sm font-semibold">
                    {safe === null ? "—" : `${safe.toFixed(safe < 10 ? 1 : 0)}%`}
                </span>
            </div>
            {detail ? <p className="metric-detail mt-1 text-xs text-quiet">{detail}</p> : null}
            <div className="metric-track mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                    className={cn("h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none", FILL[resolved])}
                    style={{ width: safe === null ? "0%" : `${safe}%` }}
                />
            </div>
        </div>
    );
}
