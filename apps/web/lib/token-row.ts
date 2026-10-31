/** What the Tokens list shows for one operator token. */

import { formatDuration } from "@/lib/attention";
import { parseTimestamp } from "@/lib/fleet-presentation";
import type { Me } from "@/lib/me";

/** An operator token as `GET /api/v1/api-keys` lists it (the secret is never included). */
export interface TokenKey {
    id: number;
    name: string;
    createdDate: string;
    active: boolean;
    expires: string | null;
    lastUsedAt: string | null;
    /** Who made it; null for tokens from before accounts. `removed` once their account is gone. */
    maker: { id: number | null; name: string; removed: boolean } | null;
}

export interface TokenRowView {
    status: "active" | "disabled" | "expired";
    lastUsed: string;
    maker: string;
    /** The expiry date (UTC), or "never". */
    expires: string;
    /** This browser signed in with it: disabling or deleting it signs this browser out. */
    isCurrent: boolean;
}

export function tokenRow(key: TokenKey, me: Me, nowMs: number): TokenRowView {
    const expiry = parseTimestamp(key.expires);
    // An expired token stays dead whatever `active` says, so expiry wins.
    const status = Number.isFinite(expiry) && expiry < nowMs ? "expired" : key.active ? "active" : "disabled";
    const used = parseTimestamp(key.lastUsedAt);
    const maker = key.maker ? (key.maker.removed ? `removed member ${key.maker.name}` : key.maker.name) : "—";
    return {
        status,
        lastUsed: Number.isFinite(used) ? `${formatDuration(Math.max(0, nowMs - used))} ago` : "never",
        maker,
        expires: Number.isFinite(expiry) ? new Date(expiry).toISOString().slice(0, 10) : "never",
        isCurrent: me.principal === "token" && me.token.id === key.id,
    };
}

export const EXPIRY_CHOICES = [
    { value: "never", label: "Never" },
    { value: "30d", label: "30 days" },
    { value: "90d", label: "90 days" },
    { value: "1y", label: "1 year" },
] as const;

export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"];

/** The `expires` to mint with: undefined for never, else an ISO time from now. */
export function expiresAt(choice: ExpiryChoice, nowMs: number): string | undefined {
    if (choice === "never") {
        return undefined;
    }
    const at = new Date(nowMs);
    if (choice === "1y") {
        at.setUTCFullYear(at.getUTCFullYear() + 1);
    } else {
        at.setUTCDate(at.getUTCDate() + (choice === "30d" ? 30 : 90));
    }
    return at.toISOString();
}
