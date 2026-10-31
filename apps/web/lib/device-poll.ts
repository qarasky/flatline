import type { DeviceSignInPoll, DeviceSignInStart } from "./device-api";
import { approveUrl } from "./device-auth";

/** How often a waiting screen asks whether a phone approved it. */
export const POLL_INTERVAL_MS = 2000;
/** How long "Request denied" stays readable before a fresh code replaces it. */
const DENIED_PAUSE_MS = 3000;
/** Pause before retrying when the server cannot be reached to start a request. */
const START_RETRY_MS = 5000;

/**
 * Sleep that ends early on abort and leaves no listener behind either way,
 * so a screen waiting for days does not accumulate them.
 */
export function abortableWait(
    ms: number,
    signal: Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener">
): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export type DeviceSignInStatus = "waiting" | "denied" | "error";

export interface DeviceSignInDeps {
    /** Origin this screen was opened on; the QR falls back to it without a public URL. */
    origin: string;
    signal: AbortSignal;
    now: () => number;
    start: () => Promise<DeviceSignInStart>;
    poll: (code: string, pollSecret: string) => Promise<DeviceSignInPoll>;
    wait: (ms: number) => Promise<void>;
    onCode: (code: { url: string; expiresAt: number }) => void;
    onStatus: (status: DeviceSignInStatus) => void;
}

/**
 * Keep a QR sign-in request alive until a phone approves it.
 *
 * Starts a request, publishes its QR URL, and polls. An expired or denied
 * request is replaced by a new one; a network error retries the same code
 * until it expires. Pure of React so it can be tested with fake timers.
 * @returns The new operator token, or null when aborted
 */
export async function runDeviceSignIn(deps: DeviceSignInDeps): Promise<string | null> {
    const { signal } = deps;

    while (!signal.aborted) {
        let started: DeviceSignInStart;
        try {
            started = await deps.start();
        } catch {
            deps.onStatus("error");
            await deps.wait(START_RETRY_MS);
            continue;
        }
        if (signal.aborted) {
            return null;
        }

        const expiresAt = deps.now() + started.expiresIn * 1000;
        deps.onCode({ url: approveUrl(started.publicUrl, deps.origin, started.code), expiresAt });
        deps.onStatus("waiting");

        let renew = false;
        while (!renew) {
            await deps.wait(POLL_INTERVAL_MS);
            if (signal.aborted) {
                return null;
            }

            let answer: DeviceSignInPoll;
            try {
                answer = await deps.poll(started.code, started.pollSecret);
            } catch {
                if (signal.aborted) {
                    return null;
                }
                deps.onStatus("error");
                renew = deps.now() >= expiresAt;
                continue;
            }
            if (signal.aborted) {
                return null;
            }

            deps.onStatus("waiting");
            if (answer.status === "approved") {
                return answer.token;
            }
            if (answer.status === "denied") {
                deps.onStatus("denied");
                await deps.wait(DENIED_PAUSE_MS);
                renew = true;
            } else if (answer.status === "expired") {
                renew = true;
            }
        }
    }
    return null;
}
