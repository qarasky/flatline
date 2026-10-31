import { retryDelayMs } from "@/lib/retry";

/**
 * Trade a just-approved screen token for a session cookie, retrying while
 * the token is still in memory: a network blip or a backend restart between
 * the phone's approval and this call must not strand a screen nobody can
 * type on. False after `attempts` failures, so the screen can start over.
 */
export async function exchangeTokenForSession(
    post: () => Promise<unknown>,
    wait: (ms: number) => Promise<void>,
    attempts = 6
): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            await post();
            return true;
        } catch {
            if (attempt < attempts - 1) {
                await wait(retryDelayMs(attempt));
            }
        }
    }
    return false;
}
