"use client";

import { Bookmark, Star, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isFilterActive, type FilterState, type SortKey } from "@/lib/board-model";
import { addView, removeView, setDefaultView, type SavedView, type SavedViews } from "@/lib/board-url";
import { cn } from "@/lib/utils";

/**
 * Saved views: named filter and sort combinations kept in this browser, one
 * of which can be the default. Applying a view only changes the board's state.
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
    const canSave = isFilterActive(filter) || sort !== "worst";
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                    <Bookmark />
                    Views
                    {state.views.length > 0 ? (
                        <span className="text-muted-foreground tabular-nums">{state.views.length}</span>
                    ) : null}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
                {state.views.length === 0 ? (
                    <p className="text-muted-foreground mb-3 text-xs">
                        Save a filter and sort combination to come back to it later. Views live in this browser.
                    </p>
                ) : (
                    <ul aria-label="Saved views" className="mb-3 space-y-0.5">
                        {state.views.map((view) => {
                            const isDefault = state.defaultId === view.id;
                            return (
                                <li key={view.id} className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onApply(view);
                                            setOpen(false);
                                        }}
                                        className="hover:bg-accent min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left"
                                    >
                                        {view.name}
                                    </button>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-pressed={isDefault}
                                        aria-label={`${isDefault ? "Unset" : "Set"} ${view.name} as default view`}
                                        title={isDefault ? "Default view (click to unset)" : "Make default"}
                                        onClick={() => onChange(setDefaultView(state, isDefault ? null : view.id))}
                                    >
                                        <Star className={cn(isDefault && "fill-primary text-primary")} />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label={`Delete view ${view.name}`}
                                        title="Delete view"
                                        onClick={() => onChange(removeView(state, view.id))}
                                    >
                                        <X />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <form
                    className="flex gap-2 border-t pt-3"
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
                        className="h-8 min-w-0 flex-1"
                    />
                    <Button type="submit" size="sm" disabled={!name.trim() || !canSave}>
                        Save
                    </Button>
                </form>
            </PopoverContent>
        </Popover>
    );
}
