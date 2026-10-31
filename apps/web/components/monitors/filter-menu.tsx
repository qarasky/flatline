"use client";

import { ListFilter } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { STATUS_LABEL } from "@/lib/board-format";
import { STATUS_KEYS, activeFilterCount, type FilterState, type StatusKey } from "@/lib/board-model";
import { cn } from "@/lib/utils";

import { StatusDot } from "./status-dot";

function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            onClick={onClick}
            className={cn(
                "hover:bg-accent flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs",
                pressed && "border-primary/60 bg-primary/10"
            )}
        >
            {children}
        </button>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="text-muted-foreground mb-1.5 text-[11px] tracking-wide uppercase">{title}</h3>
            <div className="flex flex-wrap gap-1.5">{children}</div>
        </section>
    );
}

/** Filter button with an active-count badge: status, needs attention, type and tags. */
export function FilterMenu({
    filter,
    onChange,
    types,
    tags,
    attentionCount,
}: {
    filter: FilterState;
    onChange: (next: FilterState) => void;
    types: string[];
    tags: string[];
    attentionCount: number;
}) {
    const count = activeFilterCount(filter);
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                    <ListFilter />
                    Filter
                    {count > 0 ? (
                        <span className="bg-primary text-primary-foreground inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums">
                            {count}
                        </span>
                    ) : null}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-3">
                <Section title="Status">
                    {STATUS_KEYS.map((status: StatusKey) => (
                        <Chip
                            key={status}
                            pressed={filter.status.includes(status)}
                            onClick={() => onChange({ ...filter, status: toggle(filter.status, status) })}
                        >
                            <StatusDot status={status} size={10} />
                            {STATUS_LABEL[status]}
                        </Chip>
                    ))}
                </Section>
                <div>
                    <Chip
                        pressed={filter.attention}
                        onClick={() => onChange({ ...filter, attention: !filter.attention })}
                    >
                        Needs attention
                        <span className="text-muted-foreground tabular-nums">{attentionCount}</span>
                    </Chip>
                </div>
                {types.length > 0 ? (
                    <Section title="Type">
                        {types.map((type) => (
                            <Chip
                                key={type}
                                pressed={filter.types.includes(type)}
                                onClick={() => onChange({ ...filter, types: toggle(filter.types, type) })}
                            >
                                {type}
                            </Chip>
                        ))}
                    </Section>
                ) : null}
                {tags.length > 0 ? (
                    <Section title="Tags">
                        {tags.map((tag) => (
                            <Chip
                                key={tag}
                                pressed={filter.tags.includes(tag)}
                                onClick={() => onChange({ ...filter, tags: toggle(filter.tags, tag) })}
                            >
                                {tag}
                            </Chip>
                        ))}
                    </Section>
                ) : null}
                <div className="flex justify-end border-t pt-2">
                    <Button
                        variant="ghost"
                        size="xs"
                        disabled={count === 0}
                        onClick={() => onChange({ ...filter, status: [], types: [], tags: [], attention: false })}
                    >
                        Clear filters
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
