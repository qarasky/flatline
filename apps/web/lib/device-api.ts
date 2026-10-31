/**
 * Sign-in with a QR code (ported from the old dashboard's `api.ts`). The
 * screen starts a request and polls with its secret (public); a signed-in
 * phone looks it up and approves or denies it (cookie-authenticated).
 */

import { api } from "@/lib/api";
import { SIGN_IN_PATH } from "@/lib/session";

export interface DeviceSignInStart {
    code: string;
    pollSecret: string;
    /** Seconds until the request expires. */
    expiresIn: number;
    /** The instance's configured public URL, when it has one. */
    publicUrl: string | null;
}

export type DeviceSignInPoll = { status: "pending" | "denied" | "expired" } | { status: "approved"; token: string };

export interface DeviceRequestInfo {
    userAgent: string;
    ageSeconds: number;
    suggestedName: string;
    publicUrl: string | null;
}

/** Ask to sign this screen in with a QR code. Public. */
export function startDeviceSignIn(): Promise<DeviceSignInStart> {
    return api("/api/v1/auth/device/start", { method: "POST", body: {} });
}

/** Whether a phone approved this screen; the poll secret proves it is this screen. Public. */
export function pollDeviceSignIn(code: string, pollSecret: string, signal?: AbortSignal): Promise<DeviceSignInPoll> {
    return api("/api/v1/auth/device/poll", { method: "POST", body: { code, pollSecret }, signal });
}

/** Describe a waiting screen before approving it. Needs a signed-in phone. */
export function lookupDeviceRequest(code: string): Promise<DeviceRequestInfo> {
    return api("/api/v1/auth/device/lookup", { method: "POST", body: { code } });
}

/** Approve a waiting screen; it receives its own operator token under `name`. */
export async function approveDeviceRequest(code: string, name: string): Promise<void> {
    await api("/api/v1/auth/device/approve", { method: "POST", body: { code, name } });
}

/** Turn a waiting screen away. */
export async function denyDeviceRequest(code: string): Promise<void> {
    await api("/api/v1/auth/device/deny", { method: "POST", body: { code } });
}

/**
 * Where a signed-out phone signs in, coming back to the approve page with
 * the code (it lives in the fragment, which never reaches the server).
 * Marked `expired` so a dead session cookie cannot bounce it straight back.
 */
export function deviceSignInHref(code: string | null): string {
    const back = code ? `/device#${code}` : "/device";
    return `${SIGN_IN_PATH}?expired=1&next=${encodeURIComponent(back)}`;
}
