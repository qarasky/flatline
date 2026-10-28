/** Backoff for unattended retries: 2 s, doubling, capped at 30 s. */
export function retryDelayMs(attempt: number): number {
    return Math.min(2_000 * 2 ** Math.max(0, attempt), 30_000);
}
