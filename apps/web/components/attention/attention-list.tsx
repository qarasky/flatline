"use client";

import Link from "next/link";

import { EmptyState, Spinner, cn } from "@qarasky/kore-ui";

import { useBoardData } from "@/components/board/board-data";
import { useAttention } from "@/components/board/use-attention";
import { StatusDot } from "@/components/monitors/status-dot";
import { unmutedCount, type AttentionItem, type AttentionKind } from "@/lib/attention";
import { attentionHref } from "@/lib/attention-href";

function KindMark({ kind, muted }: { kind: AttentionKind; muted: boolean }) {
    if (kind === "down") {
        return <StatusDot status="down" muted={muted} />;
    }
    if (kind === "pending") {
        return <StatusDot status="pending" />;
    }
    const glyph = { flapping: "↕", stale: "◌", agent: "!", backup: "▣" }[kind];
    return (
        <span
            aria-hidden
            className="text-status-warn text-2xs inline-flex size-3 items-center justify-center leading-none"
        >
            {glyph}
        </span>
    );
}

function Row({ item }: { item: AttentionItem }) {
    const tone = item.muted
        ? item.kind === "down"
            ? "text-status-muted"
            : "text-muted"
        : item.kind === "down"
          ? "text-status-down"
          : "text-status-warn";
    return (
        <li>
            <Link
                href={attentionHref(item)}
                className="grid min-h-row grid-cols-[12px_120px_minmax(160px,320px)_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-2 transition-colors hover:bg-white/5"
            >
                <KindMark kind={item.kind} muted={item.muted} />
                <span className={cn("text-meta font-medium", tone)}>{item.title}</span>
                <span className="truncate font-medium">{item.name}</span>
                <span className="text-muted text-meta truncate tabular-nums">
                    {item.muted ? `${item.detail} · muted` : item.detail}
                </span>
            </Link>
        </li>
    );
}

/**
 * Everything that needs a look, worst first (Plane's inbox): down, pending,
 * flapping, silent push monitors, agent warnings and failed or overdue
 * backups. Muted items (an acknowledged outage) come last, in the dim red.
 */
export function AttentionList() {
    const { rosterLoaded } = useBoardData();
    const items = useAttention();
    const open = unmutedCount(items);
    const muted = items.length - open;

    if (!rosterLoaded) {
        return (
            <div className="text-muted flex items-center gap-2 p-6">
                <Spinner />
                Loading…
            </div>
        );
    }
    return (
        <section aria-label="Needs attention" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <p role="status" className="text-muted text-meta border-b border-border px-4 py-2.5 tabular-nums">
                {open === 0 && muted === 0 ? "All clear" : `${open} need${open === 1 ? "s" : ""} attention`}
                {muted > 0 ? <span className="text-status-muted"> · {muted} muted</span> : null}
            </p>
            {items.length === 0 ? (
                <EmptyState
                    className="flex-1"
                    title="Nothing needs attention"
                    description="Outages, flapping monitors, silent agents and failed backups show up here."
                />
            ) : (
                <ul>
                    {items.map((item) => (
                        <Row key={item.key} item={item} />
                    ))}
                </ul>
            )}
        </section>
    );
}

/** How many attention items are not muted: the sidebar's count. */
export function useAttentionCount(): number {
    return unmutedCount(useAttention());
}
