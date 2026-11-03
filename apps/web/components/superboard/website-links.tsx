"use client";

import { useEffect, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogContent,
    DialogFooter,
    Input,
    StatusDot,
    Spinner,
    type Status,
} from "@qarasky/kore-ui";
import { Search } from "lucide-react";
import { ApiError } from "@/lib/api";
import type { MonitorSummary } from "@/lib/monitor-types";
import { fetchAllMonitors, fetchMonitorLinks, replaceMonitorLinks } from "@/lib/monitors-api";
import { buildLinkCandidates, linkTone, type LinkCandidate } from "@/lib/links";

/** Link tone -> kore-ui StatusDot state. */
const LINK_DOT: Record<ReturnType<typeof linkTone>, Status> = {
    up: "up",
    bad: "down",
    pending: "warn",
    maintenance: "maint",
    neutral: "off",
};

/** Status mark for a monitor status, shared with the card chips. Decorative: the name or a word goes with it. */
export function LinkStatusDot({ status }: { status: number }) {
    return <StatusDot status={LINK_DOT[linkTone(status)]} aria-hidden="true" className="shrink-0" />;
}

/**
 * Searchable checklist of groups and monitors to link to a server.
 *
 * It holds no data of its own, only the search box, so the caller owns the
 * selection state.
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
        <div className="flex flex-col gap-2">
            <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={disabled}
                leadingIcon={<Search />}
                placeholder="Filter websites and groups…"
                aria-label="Filter websites and groups"
                autoComplete="off"
            />
            <div
                className="max-h-72 overflow-y-auto rounded-ui border border-border"
                role="group"
                aria-label="Websites and groups"
            >
                {filtered.length === 0 ? (
                    <p className="px-3 py-3 text-meta text-muted">No matches.</p>
                ) : (
                    filtered.map((candidate) => (
                        <label
                            key={candidate.id}
                            className="flex min-h-control cursor-pointer items-center gap-3 border-b border-border px-3 last:border-0 hover:bg-white/5"
                        >
                            <Checkbox
                                checked={selected.has(candidate.id)}
                                disabled={disabled}
                                onCheckedChange={() => onToggle(candidate.id)}
                            />
                            <LinkStatusDot status={candidate.status} />
                            <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                            <span className="shrink-0 text-2xs text-muted">{candidate.kind}</span>
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
 * Opened from a Superboard card's menu. Saving replaces the whole link set
 * and publishes an invalidate, so every open board resnapshots and the new
 * chips land on their own.
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
                    setError(e instanceof Error ? e.message : "Couldn't load the links. Close this and try again.");
                }
            }
        }

        void load();
        return () => {
            cancelled = true;
        };
    }, [server.id]);

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
                    ? "This board token can't change links. Sign in with a token that has write scope."
                    : e instanceof Error
                      ? e.message
                      : "Couldn't save the links. Try again."
            );
            setSaving(false);
        }
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !saving) {
                    onClose();
                }
            }}
        >
            <DialogContent
                title={`Websites on “${server.name}”`}
                description="Link the website monitors this server hosts. Pick a group to include every website inside it, including ones added later. Their status appears on the server's card."
            >
                <form className="flex min-h-0 flex-col" onSubmit={(e) => void save(e)}>
                    <DialogBody>
                        {candidates === null && !error ? (
                            <p className="flex items-center gap-2 py-6 text-muted" role="status">
                                <Spinner /> Loading…
                            </p>
                        ) : (
                            <LinkPicker
                                candidates={candidates ?? []}
                                selected={selected}
                                onToggle={toggle}
                                disabled={saving}
                            />
                        )}
                        {error ? (
                            <p className="mt-3 text-meta text-danger" role="alert">
                                {error}
                            </p>
                        ) : null}
                    </DialogBody>
                    <DialogFooter className="sm:items-center">
                        <span className="mr-auto text-meta text-muted">
                            <span className="tnum">{selected.size}</span> {selected.size === 1 ? "link" : "links"}{" "}
                            selected
                        </span>
                        <Button disabled={saving} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={saving} disabled={candidates === null}>
                            {saving ? "Saving…" : "Save links"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
