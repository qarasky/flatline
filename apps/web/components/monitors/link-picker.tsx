"use client";

import { useMemo, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { statusKeyOf } from "@/lib/board-model";
import type { LinkCandidate } from "@/lib/links";

import { StatusDot } from "./status-dot";

/** Websites and groups a server hosts, filterable; a group stands for every website inside it. */
export function LinkPicker({
    candidates,
    selected,
    onToggle,
    disabled,
}: {
    candidates: LinkCandidate[];
    selected: Set<number>;
    onToggle: (id: number) => void;
    disabled?: boolean;
}) {
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return needle ? candidates.filter((c) => c.label.toLowerCase().includes(needle)) : candidates;
    }, [candidates, query]);
    return (
        <div>
            <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={disabled}
                placeholder="Filter websites and groups…"
                aria-label="Filter websites and groups"
                autoComplete="off"
                className="mb-2 h-8"
            />
            <div className="max-h-60 overflow-y-auto rounded-md border" role="group" aria-label="Websites and groups">
                {filtered.length === 0 ? (
                    <p className="text-muted-foreground px-3 py-3 text-xs">No matches.</p>
                ) : (
                    filtered.map((candidate) => (
                        <label
                            key={candidate.id}
                            className="border-border/60 hover:bg-accent flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 last:border-0"
                        >
                            <Checkbox
                                checked={selected.has(candidate.id)}
                                disabled={disabled}
                                onCheckedChange={() => onToggle(candidate.id)}
                            />
                            <StatusDot status={statusKeyOf({ active: true, status: candidate.status })} size={9} />
                            <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                            <span className="text-muted-foreground shrink-0 text-[11px] tracking-wide uppercase">
                                {candidate.kind}
                            </span>
                        </label>
                    ))
                )}
            </div>
        </div>
    );
}
