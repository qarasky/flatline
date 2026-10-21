import { useCallback, useState } from "react";
import { isFilterActive, type FilterState, type SortKey } from "@/lib/board-model";
import { addView, removeView, setDefaultView, type SavedView, type SavedViews } from "@/lib/board-url";
import { Popover } from "./Popover";
import { Input } from "@/components/ui/input";

/**
 * Saved views: named filter + sort combinations kept in this browser, one of
 * which can be the default. Applying a view only changes the board's state.
 */
export function ViewsMenu({
    state,
    onChange,
    onApply,
    filter,
    sort,
}: {
    state: SavedViews;
    onChange: (next: SavedViews) => void;
    onApply: (view: SavedView) => void;
    filter: FilterState;
    sort: SortKey;
}) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const close = useCallback(() => setOpen(false), []);
    const canSave = isFilterActive(filter) || sort !== "worst";

    return (
        <div className="relative">
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-surface-hover"
            >
                Views
                {state.views.length > 0 ? <span className="tnum text-quiet">{state.views.length}</span> : null}
            </button>
            <Popover open={open} onClose={close} label="Saved views" className="w-72">
                {state.views.length === 0 ? (
                    <p className="mb-3 text-xs text-quiet">
                        Save a filter and sort combination to come back to it later. Views live in this browser.
                    </p>
                ) : (
                    <ul className="mb-3 space-y-0.5">
                        {state.views.map((view) => (
                            <li key={view.id} className="group flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => {
                                        onApply(view);
                                        close();
                                    }}
                                    className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover"
                                >
                                    {view.name}
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={state.defaultId === view.id}
                                    title={
                                        state.defaultId === view.id ? "Default view (click to unset)" : "Make default"
                                    }
                                    aria-label={`${state.defaultId === view.id ? "Unset" : "Set"} ${view.name} as default view`}
                                    onClick={() =>
                                        onChange(setDefaultView(state, state.defaultId === view.id ? null : view.id))
                                    }
                                    className={`rounded px-1.5 py-1 text-xs transition-colors hover:bg-surface-hover ${
                                        state.defaultId === view.id ? "text-primary" : "text-quiet"
                                    }`}
                                >
                                    {state.defaultId === view.id ? "★ default" : "☆"}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Delete view ${view.name}`}
                                    title="Delete view"
                                    onClick={() => onChange(removeView(state, view.id))}
                                    className="rounded px-1.5 py-1 text-xs text-quiet transition-colors hover:bg-surface-hover hover:text-bad"
                                >
                                    ✕
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <form
                    className="flex gap-2 border-t border-border pt-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!name.trim() || !canSave) {
                            return;
                        }
                        onChange(addView(state, name, filter, sort));
                        setName("");
                    }}
                >
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={canSave ? "Name this view" : "Set a filter or sort first"}
                        disabled={!canSave}
                        aria-label="View name"
                        maxLength={40}
                        className="min-w-0 flex-1 disabled:opacity-50"
                    />
                    <button
                        type="submit"
                        disabled={!name.trim() || !canSave}
                        className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    >
                        Save
                    </button>
                </form>
            </Popover>
        </div>
    );
}
