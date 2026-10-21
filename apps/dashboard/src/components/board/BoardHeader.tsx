import { useCallback, useState, type ReactNode } from "react";
import type { Density } from "@/lib/board-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover } from "./Popover";

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

/** Secondary actions, folded into a menu below the xl breakpoint. */
function MoreMenu(props: {
    onSuperboard: () => void;
    onAgents: () => void;
    onNewGroup: () => void;
    onDisconnect: () => void;
}) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const item = (label: string, run: () => void) => (
        <button
            type="button"
            className="block w-full rounded px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover"
            onClick={() => {
                close();
                run();
            }}
        >
            {label}
        </button>
    );
    return (
        <div className="relative xl:hidden">
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label="More actions"
                onClick={() => setOpen((v) => !v)}
                className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-surface-hover"
            >
                More
            </button>
            <Popover open={open} onClose={close} label="More actions" align="right" className="w-44 p-1">
                {item("Superboard", props.onSuperboard)}
                {item("Agents", props.onAgents)}
                {item("New group", props.onNewGroup)}
                {item("Disconnect", props.onDisconnect)}
            </Popover>
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
                    className="h-8 w-48 pr-14 xl:w-64"
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
                aria-label={props.paused ? "Resume live updates" : "Pause live updates"}
                onClick={props.onTogglePaused}
                title={props.paused ? "Resume live updates" : "Pause live updates"}
                className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-surface-hover ${
                    props.paused ? "border-warn/50 text-warn" : "border-border"
                }`}
            >
                <span aria-hidden>{props.paused ? "▶" : "❚❚"}</span>
                <span className="hidden xl:inline">{props.paused ? "Resume live" : "Pause live"}</span>
            </button>

            <div className="ml-auto flex items-center gap-2">
                <div className="hidden items-center gap-2 xl:flex">
                    <Button size="sm" variant="outline" onClick={props.onSuperboard}>
                        Superboard
                    </Button>
                    <Button size="sm" variant="outline" onClick={props.onAgents}>
                        Agents
                    </Button>
                    <Button size="sm" variant="outline" onClick={props.onNewGroup}>
                        New group
                    </Button>
                </div>
                <MoreMenu {...props} />
                <Button size="sm" onClick={props.onNewMonitor}>
                    New monitor
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    title="Forget token"
                    className="hidden xl:inline-flex"
                    onClick={props.onDisconnect}
                >
                    Disconnect
                </Button>
            </div>
        </header>
    );
}
