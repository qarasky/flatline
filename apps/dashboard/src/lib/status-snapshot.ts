import type { StatusPageSnapshot } from "@flatline/shared";

/**
 * State machine behind the public status page, kept pure so the rules can be
 * tested without a browser:
 *
 * - Host resolution: only a successful answer with `slug: null` means "this
 *   host is not a status domain". Anything else (network error, 5xx, a body
 *   that is not the expected shape) is an error to retry, never "unmapped" —
 *   an unmapped host renders the operator token gate, which must not happen
 *   on a client's status domain because the server blinked.
 * - Page refresh: once a page has rendered, a failed refresh keeps the last
 *   good snapshot on screen and marks it stale instead of replacing it with
 *   an error. A failed heartbeat fetch inside an otherwise good refresh keeps
 *   the previous beats (see `fetchStatusPage`'s `previous` option) and also
 *   counts as stale.
 */

export type HostState =
    | { kind: "resolving" }
    | { kind: "mapped"; slug: string }
    | { kind: "unmapped" }
    | { kind: "error"; message: string };

/**
 * Classify a `resolve-host` response.
 * @param ok Whether the HTTP status was 2xx
 * @param body Parsed JSON body (anything)
 * @returns Mapped, unmapped, or an error to retry
 */
export function parseResolveHost(ok: boolean, body: unknown): HostState {
    if (!ok) {
        return { kind: "error", message: "The status server did not answer." };
    }
    if (typeof body !== "object" || body === null || !("slug" in body)) {
        return { kind: "error", message: "Unexpected answer from the status server." };
    }
    const slug = (body as { slug: unknown }).slug;
    if (slug === null) {
        return { kind: "unmapped" };
    }
    if (typeof slug === "string" && slug !== "") {
        return { kind: "mapped", slug };
    }
    return { kind: "error", message: "Unexpected answer from the status server." };
}

/**
 * Backoff for retries after a failure: 2 s, 4 s, 8 s … capped at 60 s, with
 * ±20 % jitter so a room full of screens does not retry in lockstep.
 * @param attempt Zero-based count of consecutive failures before this retry
 * @param random Source of randomness in [0, 1)
 * @returns Delay in milliseconds
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
    return Math.round(base * (0.8 + random() * 0.4));
}

export type LoadOutcome =
    | { kind: "ok"; snapshot: StatusPageSnapshot }
    | { kind: "locked" }
    | { kind: "notfound" }
    | { kind: "error"; message: string };

export type PagePhase =
    | { phase: "loading" }
    | {
          phase: "page";
          slug: string;
          snapshot: StatusPageSnapshot;
          /** When the data on screen was last fully refreshed (epoch ms). */
          updatedAt: number;
          /** The last refresh failed, fully or for the heartbeats. */
          stale: boolean;
      }
    | { phase: "locked"; slug: string }
    | { phase: "notfound" }
    | { phase: "error"; message: string };

/**
 * Fold one load outcome into the page state.
 * @param previous Current state
 * @param outcome What the load returned
 * @param slug The slug that was loaded
 * @param now Epoch millis of the outcome
 * @returns Next state
 */
export function nextPagePhase(previous: PagePhase, outcome: LoadOutcome, slug: string, now: number): PagePhase {
    const shown = previous.phase === "page" && previous.slug === slug ? previous : null;
    switch (outcome.kind) {
        case "ok": {
            const heartbeatsFailed = outcome.snapshot.degraded?.includes("heartbeats") ?? false;
            return {
                phase: "page",
                slug,
                snapshot: outcome.snapshot,
                // Beats carried over from the last good load are as old as
                // that load; say so instead of pretending they are fresh.
                updatedAt: heartbeatsFailed && shown ? shown.updatedAt : now,
                stale: heartbeatsFailed,
            };
        }
        case "error":
            return shown ? { ...shown, stale: true } : { phase: "error", message: outcome.message };
        case "locked":
            return { phase: "locked", slug };
        case "notfound":
            return { phase: "notfound" };
    }
}

/**
 * Whether the outcome should be retried on the backoff schedule rather than
 * the normal refresh interval.
 */
export function shouldBackOff(outcome: LoadOutcome): boolean {
    return (
        outcome.kind === "error" ||
        (outcome.kind === "ok" && (outcome.snapshot.degraded?.includes("heartbeats") ?? false))
    );
}
