"use client";

import { ListFilter } from "lucide-react";

import { Button, Popover, PopoverContent, PopoverTrigger, cn } from "@qarasky/kore-ui";

import { STATUS_LABEL } from "@/lib/board-format";
import { STATUS_KEYS, activeFilterCount, type FilterState, type StatusKey } from "@/lib/board-model";

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
                "text-meta flex h-7 items-center gap-1.5 rounded-ui border border-border-strong px-2 transition-colors hover:bg-white/5",
                pressed && "border-accent/60 bg-accent/10"
            )}
        >
            {children}
        </button>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="text-muted text-meta mb-1.5 font-medium">{title}</h3>
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
                <Button size="sm">
                    <ListFilter />
                    Filter
                    {count > 0 ? (
                        <span className="bg-accent text-2xs inline-flex min-w-4 items-center justify-center rounded-full px-1 leading-4 font-semibold text-white tabular-nums">
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
                            <StatusDot status={status} />
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
                        <span className="text-muted tabular-nums">{attentionCount}</span>
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
                        size="sm"
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
