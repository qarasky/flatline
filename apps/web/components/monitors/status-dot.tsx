import { StatusDot as KoreStatusDot, cn, type Status } from "@qarasky/kore-ui";

import { STATUS_LABEL } from "@/lib/board-format";
import type { StatusKey } from "@/lib/board-model";

const TONE: Record<StatusKey, string> = {
    up: "text-status-up",
    down: "text-status-down",
    pending: "text-status-warn",
    maintenance: "text-status-maint",
    paused: "text-muted",
};

/** Monitor status -> kore-ui StatusDot state. */
const KORE: Record<StatusKey, Status> = {
    up: "up",
    down: "down",
    pending: "warn",
    maintenance: "maint",
    paused: "off",
};

/** Text colour class for a status. */
export function statusTone(status: StatusKey): string {
    return TONE[status];
}

/**
 * Status mark: kore-ui's StatusDot (disc, diamond for down, rings for
 * maintenance and paused) so it reads without colour; a word always goes
 * with it. The dot itself is announced as an image with the status name.
 */
export function StatusDot({
    status,
    title,
    muted = false,
    className,
}: {
    status: StatusKey;
    /** Kept for callers that still pass it; kore-ui's dot has one size (8px). */
    size?: number;
    title?: string;
    /** An acknowledged outage: a down mark in the dim red. */
    muted?: boolean;
    className?: string;
}) {
    return (
        <KoreStatusDot
            status={KORE[status]}
            role="img"
            aria-label={title ?? STATUS_LABEL[status]}
            data-muted={(muted && status === "down") || undefined}
            className={cn("shrink-0", muted && status === "down" && "[&_span]:bg-status-muted", className)}
        />
    );
}
