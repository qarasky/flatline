import { Button } from "@/components/ui/button";

/** Static placeholder while the roster loads: no shimmer on a screen that is watched all day. */
export function BoardSkeleton({ rows = 8 }: { rows?: number }) {
    return (
        <div aria-busy="true" aria-label="Loading monitors" role="status" className="py-1">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex h-11 items-center gap-4 px-4">
                    <span className="board-skeleton-bar size-3 rounded-full" />
                    <span className="board-skeleton-bar h-3" style={{ width: `${160 + ((i * 53) % 120)}px` }} />
                    <span className="board-skeleton-bar ml-auto hidden h-4 w-56 md:block" />
                    <span className="board-skeleton-bar h-3 w-12" />
                </div>
            ))}
            <span className="sr-only">Loading monitors…</span>
        </div>
    );
}

export function EmptyBoard({ onNewMonitor }: { onNewMonitor: () => void }) {
    return (
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <p className="font-medium">No monitors yet</p>
            <p className="text-muted-foreground max-w-sm text-xs">
                Add an HTTP, ping or push monitor, or a group to organise them.
            </p>
            <Button size="sm" onClick={onNewMonitor}>
                New monitor
            </Button>
        </div>
    );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
    return (
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <p className="font-medium">Nothing matches</p>
            <p className="text-muted-foreground text-xs">No monitor fits the current search and filters.</p>
            <Button size="sm" variant="outline" onClick={onClear}>
                Clear search and filters
            </Button>
        </div>
    );
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <p className="font-medium">Could not load the monitors</p>
            <p className="text-status-down max-w-md text-xs">{message}</p>
            <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
            </Button>
        </div>
    );
}
