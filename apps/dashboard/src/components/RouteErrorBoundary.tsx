import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

/** How long an unattended wall shows the error before reloading itself. */
export const KIOSK_RELOAD_MS = 30_000;

interface Props {
    /**
     * Unattended route (the kiosk wall, a public status page): show the error
     * and reload the page on its own, because nobody is there to click.
     */
    autoReload?: boolean;
    /** Changing this (e.g. the path) clears a caught error. */
    resetKey?: string;
    children: ReactNode;
}

interface State {
    error: Error | null;
    resetKey?: string;
}

/**
 * Error boundary for one top-level route.
 *
 * Without it a single render exception unmounts the whole tree: a wall goes
 * blank and its live stream is torn down until someone reloads by hand. With
 * it, an operator route shows a recoverable error, and an unattended route
 * shows the error and reloads itself after {@link KIOSK_RELOAD_MS}.
 *
 * A lazy route chunk that fails to load (typically an old tab after a
 * deploy removed its hashed assets) lands here too, and a reload is exactly
 * the right fix for that.
 */
export class RouteErrorBoundary extends Component<Props, State> {
    state: State = { error: null, resetKey: this.props.resetKey };

    static getDerivedStateFromError(error: unknown): Partial<State> {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
        // Navigating away from a broken route gives the next one a clean slate.
        if (props.resetKey !== state.resetKey) {
            return { error: null, resetKey: props.resetKey };
        }
        return null;
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("Route crashed", error, info.componentStack);
    }

    private reset = () => this.setState({ error: null });

    render() {
        const { error } = this.state;
        if (!error) {
            return this.props.children;
        }
        return this.props.autoReload ? (
            <AutoReloadError error={error} />
        ) : (
            <RecoverableError error={error} onRetry={this.reset} />
        );
    }
}

function RecoverableError({ error, onRetry }: { error: Error; onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-lg px-4 py-16" role="alert">
            <h1 className="mb-2 text-base font-semibold">Something went wrong on this page.</h1>
            <p className="mb-4 text-sm break-words text-quiet">{error.message || "Unknown error"}</p>
            <div className="flex gap-2">
                <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
                    onClick={onRetry}
                >
                    Try again
                </button>
                <button
                    type="button"
                    className="rounded-md px-3 py-1.5 text-sm text-quiet hover:text-foreground"
                    onClick={() => window.location.reload()}
                >
                    Reload page
                </button>
            </div>
        </div>
    );
}

function AutoReloadError({ error }: { error: Error }) {
    const [deadline] = useState(() => Date.now() + KIOSK_RELOAD_MS);
    const [left, setLeft] = useState(Math.ceil(KIOSK_RELOAD_MS / 1000));

    useEffect(() => {
        const timer = window.setInterval(() => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                window.clearInterval(timer);
                window.location.reload();
                return;
            }
            setLeft(Math.ceil(remaining / 1000));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [deadline]);

    return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-2 p-6 text-center" role="alert">
            <p className="text-lg font-semibold">This screen hit an error.</p>
            <p className="max-w-xl text-sm break-words text-quiet">{error.message || "Unknown error"}</p>
            <p className="tnum text-sm text-quiet">Reloading in {left}s…</p>
        </div>
    );
}
