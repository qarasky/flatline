/**
 * Wrap a refresh so at most one runs at a time. A trigger that arrives while
 * one is running queues exactly one more run (which sees the newest state);
 * further triggers in that window join it. Bursts of live events (backup
 * upload progress arrives about once a second) then cost two fetches, not
 * one per event, and responses can never land out of order.
 * @param task The refresh to run
 * @returns A trigger that resolves when the run covering this call is done
 */
export function serialRefresh(task: () => Promise<void>): () => Promise<void> {
    let running: Promise<void> | null = null;
    let queued: Promise<void> | null = null;

    const start = (): Promise<void> => {
        const run = task().finally(() => {
            running = null;
        });
        running = run;
        return run;
    };

    return () => {
        if (!running) {
            return start();
        }
        if (!queued) {
            queued = running
                .catch(() => {})
                .then(() => {
                    queued = null;
                    return start();
                });
        }
        return queued;
    };
}
