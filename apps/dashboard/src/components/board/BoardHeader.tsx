import type { ReactNode } from "react";
import type { Density } from "@/lib/board-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function DensityToggle({ density, onChange }: { density: Density; onChange: (d: Density) => void }) {
    const option = (value: Density, label: string, lines: number) => (
        <button
            type="button"
            aria-pressed={density === value}
            aria-label={`${label} rows`}
            title={`${label} rows`}
            onClick={() => onChange(value)}
            className={`flex size-8 items-center justify-center transition-colors ${
                density === value ? "bg-surface-hover text-foreground" : "text-quiet hover:text-foreground"
            }`}
        >
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden fill="currentColor">
                {Array.from({ length: lines }, (_, i) => (
                    <rect
                        key={i}
                        x="1"
                        y={1 + (i * 12) / lines + (lines === 3 ? 0 : 1)}
                        width="12"
                        height="1.6"
                        rx="0.8"
                    />
                ))}
            </svg>
        </button>
    );
    return (
        <div role="group" aria-label="Row density" className="flex overflow-hidden rounded-md border border-border">
            {option("comfortable", "Comfortable", 3)}
            {option("compact", "Compact", 5)}
        </div>
    );
}

/**
 * Board header: brand, search, filter/views controls, density, pause and the
 * operator actions.
 */
export function BoardHeader(props: {
    query: string;
    onQuery: (q: string) => void;
    matchCount: number | null;
    total: number;
    filters: ReactNode;
    density: Density;
    onDensity: (d: Density) => void;
    paused: boolean;
    onTogglePaused: () => void;
    onNewMonitor: () => void;
    onNewGroup: () => void;
    onSuperboard: () => void;
    onAgents: () => void;
    onDisconnect: () => void;
}) {
    return (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4">
            <span className="mr-2 text-base font-semibold tracking-tight">Flatline</span>

            <div className="relative">
                <Input
                    id="monitor-search"
                    value={props.query}
                    onChange={(e) => props.onQuery(e.target.value)}
                    placeholder="Search monitors  ( / )"
                    aria-label="Search monitors"
                    className="h-8 w-64 pr-14"
                />
                <kbd
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border px-1.5 text-[10px] text-quiet"
                >
                    /
                </kbd>
            </div>
            {props.matchCount !== null ? (
                <span className="text-xs text-quiet">
                    <span className="tnum">{props.matchCount}</span> of <span className="tnum">{props.total}</span>
                </span>
            ) : null}

            {props.filters}
            <DensityToggle density={props.density} onChange={props.onDensity} />
            <button
                type="button"
                aria-pressed={props.paused}
                onClick={props.onTogglePaused}
                title={props.paused ? "Resume live updates" : "Pause live updates"}
                className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-surface-hover ${
                    props.paused ? "border-warn/50 text-warn" : "border-border"
                }`}
            >
                <span aria-hidden>{props.paused ? "▶" : "❚❚"}</span>
                {props.paused ? "Resume" : "Pause"}
            </button>

            <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={props.onSuperboard}>
                    Superboard
                </Button>
                <Button size="sm" variant="outline" onClick={props.onAgents}>
                    Agents
                </Button>
                <Button size="sm" variant="outline" onClick={props.onNewGroup}>
                    New group
                </Button>
                <Button size="sm" onClick={props.onNewMonitor}>
                    New monitor
                </Button>
                <Button variant="ghost" size="sm" title="Forget token" onClick={props.onDisconnect}>
                    Disconnect
                </Button>
            </div>
        </header>
    );
}
