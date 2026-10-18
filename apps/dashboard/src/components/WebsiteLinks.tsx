import { useEffect, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";
import { ApiError, fetchAllMonitors, fetchMonitorLinks, replaceMonitorLinks, type MonitorSummary } from "@/lib/api";
import { buildLinkCandidates, linkTone, type LinkCandidate } from "@/lib/links";

/** Colored dot for a monitor status, shared with the card chips. */
export function LinkStatusDot({ status }: { status: number }) {
    return <span aria-hidden="true" className="fleet-link-dot" data-tone={linkTone(status)} />;
}

/**
 * Searchable checklist of groups and monitors to link to a server.
 *
 * Reused by the card dialog and the monitor edit form; it holds no data of
 * its own, only the search box, so both callers own the selection state.
 */
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
        if (!needle) {
            return candidates;
        }
        return candidates.filter((candidate) => candidate.label.toLowerCase().includes(needle));
    }, [candidates, query]);

    return (
        <div>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={disabled}
                placeholder="Filter websites and groups…"
                aria-label="Filter websites and groups"
                autoComplete="off"
                className="mb-2 h-9 w-full rounded-md border border-input bg-surface px-2 text-sm"
            />
            <div
                className="max-h-60 overflow-y-auto rounded-md border border-border"
                role="group"
                aria-label="Websites and groups"
            >
                {filtered.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-quiet">No matches.</p>
                ) : (
                    filtered.map((candidate) => (
                        <label
                            key={candidate.id}
                            className="flex cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1.5 text-sm last:border-0 hover:bg-surface"
                        >
                            <input
                                type="checkbox"
                                checked={selected.has(candidate.id)}
                                disabled={disabled}
                                onChange={() => onToggle(candidate.id)}
                                className="size-3.5 accent-[var(--primary)]"
                            />
                            <LinkStatusDot status={candidate.status} />
                            <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                            <span className="shrink-0 text-[11px] uppercase tracking-wide text-quiet">
                                {candidate.kind}
                            </span>
                        </label>
                    ))
                )}
            </div>
        </div>
    );
}

/**
 * Link the websites hosted on a server.
 *
 * Opened from a Superboard card's context menu. Saving replaces the whole
 * link set and publishes an invalidate, so every open board resnapshots and
 * the new chips land on their own.
 */
export function WebsiteLinkDialog({ server, onClose }: { server: MonitorSummary; onClose: () => void }) {
    const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const [monitors, links] = await Promise.all([fetchAllMonitors(), fetchMonitorLinks(server.id)]);
                if (cancelled) {
                    return;
                }
                setCandidates(buildLinkCandidates(monitors, server.id));
                setSelected(new Set(links.raw.map((link) => link.linkedMonitorId)));
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "Could not load links.");
                }
            }
        }

        void load();
        return () => {
            cancelled = true;
        };
    }, [server.id]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    function toggle(id: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    async function save(event?: SyntheticEvent) {
        event?.preventDefault();
        setSaving(true);
        setError(null);
        try {
            await replaceMonitorLinks(server.id, [...selected]);
            onClose();
        } catch (e) {
            setError(
                e instanceof ApiError && e.status === 403
                    ? "This board token can't change links (needs write scope)."
                    : e instanceof Error
                      ? e.message
                      : "Save failed."
            );
            setSaving(false);
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                    onClose();
                }
            }}
        >
            <form
                role="dialog"
                aria-modal="true"
                aria-label={`Websites on ${server.name}`}
                className="mt-8 w-full max-w-lg rounded-lg border border-border bg-card p-5"
                onSubmit={(e) => void save(e)}
            >
                <h2 className="mb-1 text-base font-semibold">Websites on “{server.name}”</h2>
                <p className="mb-3 text-xs text-quiet">
                    Link the website monitors this server hosts. Pick a group to include every website inside it,
                    including ones added later. Their status appears on the server's card.
                </p>

                {candidates === null && !error ? (
                    <p className="py-6 text-sm text-quiet">Loading…</p>
                ) : (
                    <LinkPicker candidates={candidates ?? []} selected={selected} onToggle={toggle} disabled={saving} />
                )}

                {error ? (
                    <p className="mt-3 text-xs text-bad" role="alert">
                        {error}
                    </p>
                ) : null}

                <div className="mt-4 flex items-center justify-between gap-2">
                    <span className="text-xs text-quiet">
                        <span className="tnum">{selected.size}</span> {selected.size === 1 ? "link" : "links"} selected
                    </span>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={saving}
                            onClick={onClose}
                            className="rounded-md px-3 py-1.5 text-sm text-quiet hover:text-primary"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={saving || candidates === null}
                            className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                        >
                            {saving ? "Saving…" : "Save links"}
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
}
