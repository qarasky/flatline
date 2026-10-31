"use client";

import Link from "next/link";

import { useBoardData } from "@/components/board/board-data";
import { useAttention } from "@/components/board/use-attention";
import { StatusDot } from "@/components/monitors/status-dot";
import { unmutedCount, type AttentionItem, type AttentionKind } from "@/lib/attention";
import { attentionHref } from "@/lib/attention-href";
import { cn } from "@/lib/utils";

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
            className="text-status-warn inline-flex size-3 items-center justify-center text-[11px] leading-none"
        >
            {glyph}
        </span>
    );
}

function Row({ item }: { item: AttentionItem }) {
    const tone = item.muted
        ? item.kind === "down"
            ? "text-status-muted"
            : "text-muted-foreground"
        : item.kind === "down"
          ? "text-status-down"
          : "text-status-warn";
    return (
        <li>
            <Link
                href={attentionHref(item)}
                className="hover:bg-accent grid grid-cols-[12px_120px_minmax(160px,320px)_minmax(0,1fr)] items-center gap-3 border-b px-4 py-2.5"
            >
                <KindMark kind={item.kind} muted={item.muted} />
                <span className={cn("text-xs font-medium", tone)}>{item.title}</span>
                <span className="truncate font-medium">{item.name}</span>
                <span className="text-muted-foreground truncate text-xs tabular-nums">
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
        return <p className="text-muted-foreground p-6">Loading…</p>;
    }
    return (
        <section aria-label="Needs attention" className="flex flex-1 flex-col">
            <p role="status" className="text-muted-foreground border-b px-4 py-2.5 text-xs tabular-nums">
                {open === 0 && muted === 0 ? "All clear" : `${open} need${open === 1 ? "s" : ""} attention`}
                {muted > 0 ? <span className="text-status-muted"> · {muted} muted</span> : null}
            </p>
            {items.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-10">
                    <p className="text-muted-foreground">Nothing needs attention.</p>
                </div>
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

/** The sidebar's count: unmuted items only, hidden at zero; a dot when the sidebar is icons only. */
export function AttentionCount() {
    const open = unmutedCount(useAttention());
    if (open === 0) {
        return null;
    }
    return (
        <>
            <span
                data-sidebar="menu-badge"
                aria-label={`${open} need attention`}
                className="text-status-down pointer-events-none absolute top-1.5 right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums group-data-[collapsible=icon]:hidden"
            >
                {open}
            </span>
            <span
                aria-hidden
                className="bg-status-down pointer-events-none absolute top-1.5 right-1.5 hidden size-2 rounded-full group-data-[collapsible=icon]:block"
            />
        </>
    );
}
