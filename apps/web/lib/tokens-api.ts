/** Operator tokens (`/api/v1/api-keys`) for the Tokens section. */

import { api } from "@/lib/api";
import type { TokenKey } from "@/lib/token-row";

export async function fetchTokens(): Promise<TokenKey[]> {
    const body = await api<{ apiKeys: TokenKey[] }>("/api/v1/api-keys");
    return body.apiKeys;
}

/** Mint a token; the secret is in the answer once and never again. */
export function mintToken(input: { name: string; expires?: string }): Promise<{ apiKey: TokenKey; token: string }> {
    return api("/api/v1/api-keys", { method: "POST", body: input });
}

export function setTokenActive(id: number, active: boolean): Promise<{ apiKey: TokenKey }> {
    return api(`/api/v1/api-keys/${id}`, { method: "PATCH", body: { active } });
}

export function deleteToken(id: number): Promise<{ deleted: number }> {
    return api(`/api/v1/api-keys/${id}`, { method: "DELETE" });
}
