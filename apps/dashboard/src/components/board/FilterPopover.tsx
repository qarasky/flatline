import { useCallback, useState } from "react";
import { STATUS_LABEL } from "@/lib/board-format";
import { STATUS_KEYS, activeFilterCount, type FilterState, type StatusKey } from "@/lib/board-model";
import { Chip, Popover } from "./Popover";
import { StatusDot } from "./StatusDot";

function toggle<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Filter button with an active-count badge and a chip popover (status, type, tags, needs attention). */
export function FilterPopover({
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
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const count = activeFilterCount(filter);

    return (
        <div className="relative">
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-surface-hover"
            >
                Filter
                {count > 0 ? (
                    <span className="tnum inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                        {count}
                    </span>
                ) : null}
            </button>
            <Popover open={open} onClose={close} label="Filters" className="w-80">
                <div className="space-y-3">
                    <section>
                        <h3 className="mb-1.5 text-[11px] tracking-wide text-quiet uppercase">Status</h3>
                        <div className="flex flex-wrap gap-1.5">
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
                        </div>
                    </section>
                    <section>
                        <Chip
                            pressed={filter.attention}
                            onClick={() => onChange({ ...filter, attention: !filter.attention })}
                        >
                            Needs attention
                            <span className="tnum text-quiet">{attentionCount}</span>
                        </Chip>
                    </section>
                    {types.length > 0 ? (
                        <section>
                            <h3 className="mb-1.5 text-[11px] tracking-wide text-quiet uppercase">Type</h3>
                            <div className="flex flex-wrap gap-1.5">
                                {types.map((type) => (
                                    <Chip
                                        key={type}
                                        pressed={filter.types.includes(type)}
                                        onClick={() => onChange({ ...filter, types: toggle(filter.types, type) })}
                                    >
                                        {type}
                                    </Chip>
                                ))}
                            </div>
                        </section>
                    ) : null}
                    {tags.length > 0 ? (
                        <section>
                            <h3 className="mb-1.5 text-[11px] tracking-wide text-quiet uppercase">Tags</h3>
                            <div className="flex flex-wrap gap-1.5">
                                {tags.map((tag) => (
                                    <Chip
                                        key={tag}
                                        pressed={filter.tags.includes(tag)}
                                        onClick={() => onChange({ ...filter, tags: toggle(filter.tags, tag) })}
                                    >
                                        {tag}
                                    </Chip>
                                ))}
                            </div>
                        </section>
                    ) : null}
                    <div className="flex justify-end border-t border-border pt-2">
                        <button
                            type="button"
                            disabled={count === 0}
                            onClick={() => onChange({ ...filter, status: [], types: [], tags: [], attention: false })}
                            className="text-xs text-muted transition-colors hover:text-foreground disabled:opacity-40"
                        >
                            Clear filters
                        </button>
                    </div>
                </div>
            </Popover>
        </div>
    );
}
