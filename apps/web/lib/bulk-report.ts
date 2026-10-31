import { isApiError } from "@/lib/api";

/**
 * Which deletes went through and which failed, by name. A monitor someone
 * else already deleted (404) counts as deleted: it is gone either way.
 */
export function splitDeleteResults(
    monitors: { id: number; name: string }[],
    results: PromiseSettledResult<unknown>[]
): { deleted: number[]; failed: string[] } {
    const deleted: number[] = [];
    const failed: string[] = [];
    monitors.forEach((monitor, i) => {
        const result = results[i];
        if (result.status === "fulfilled" || isApiError(result.reason, 404)) {
            deleted.push(monitor.id);
        } else {
            failed.push(monitor.name);
        }
    });
    return { deleted, failed };
}

/** "Could not delete B, C." or null when nothing failed. */
export function bulkFailureMessage(verb: string, failedNames: string[]): string | null {
    return failedNames.length > 0 ? `Could not ${verb} ${failedNames.join(", ")}.` : null;
}
