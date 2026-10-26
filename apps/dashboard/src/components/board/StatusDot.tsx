import type { StatusKey } from "@/lib/board-model";
import { STATUS_LABEL } from "@/lib/board-format";

const TONE: Record<StatusKey, string> = {
    up: "text-ok",
    down: "text-bad",
    pending: "text-warn",
    maintenance: "text-maint",
    paused: "text-quiet",
};

/** Text colour class for a status. */
export function statusTone(status: StatusKey): string {
    return TONE[status];
}

/**
 * Status mark. The shape differs per status (disc, diamond, half disc, ring,
 * bars) so it is readable without colour; a word always accompanies it
 * somewhere on the row.
 */
export function StatusDot({
    status,
    size = 12,
    title,
    muted = false,
}: {
    status: StatusKey;
    size?: number;
    title?: string;
    /** An acknowledged outage: a down mark in the dim red. */
    muted?: boolean;
}) {
    return (
        <svg
            viewBox="0 0 12 12"
            width={size}
            height={size}
            className={`board-status-dot shrink-0 ${muted && status === "down" ? "text-bad-dim" : TONE[status]}`}
            role="img"
            aria-label={title ?? STATUS_LABEL[status]}
        >
            {status === "up" ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
            {status === "down" ? <path d="M6 0.8 11.2 6 6 11.2 0.8 6Z" fill="currentColor" /> : null}
            {status === "pending" ? (
                <>
                    <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M6 2a4 4 0 0 1 0 8Z" fill="currentColor" />
                </>
            ) : null}
            {status === "maintenance" ? (
                <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
            ) : null}
            {status === "paused" ? (
                <>
                    <rect x="2.5" y="2" width="2.4" height="8" rx="0.6" fill="currentColor" />
                    <rect x="7.1" y="2" width="2.4" height="8" rx="0.6" fill="currentColor" />
                </>
            ) : null}
        </svg>
    );
}
