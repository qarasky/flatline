import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { ApiError, createApiKey, deleteApiKey, fetchApiKeys, setApiKeyActive, type ApiKeySummary } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

const BASE = (import.meta.env.VITE_FLATLINE_URL as string | undefined) ?? "";

const SCOPE_HELP: Record<string, string> = {
    read: "List and inspect everything. Cannot change anything.",
    write: "Create and change monitors, pages and incidents. Cannot publish.",
    publish: "Everything, including making status pages public. Hand out rarely.",
};

const ALL_SCOPES = ["read", "write", "publish"];

/**
 * Agent panel: mint scoped tokens, revoke them, and hand an agent everything
 * it needs to self-document.
 *
 * Two things this panel exists to prevent:
 * 1. Paste-once tokens. The plaintext is shown exactly once, at creation, the
 *    same guarantee the server makes. There is no "show again".
 * 2. Over-scoped agent tokens. Scopes default to read-only and each scope is
 *    explained in plain language, because an agent holding delete rights on
 *    your monitors is a footgun.
 */
export function AgentPanel({ onClose }: { onClose: () => void }) {
    const [keys, setKeys] = useState<ApiKeySummary[]>([]);
    const [availableScopes, setAvailableScopes] = useState<string[]>(ALL_SCOPES);
    const [name, setName] = useState("");
    const [scopes, setScopes] = useState<Set<string>>(new Set(["read"]));
    const [freshToken, setFreshToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);

    async function load() {
        try {
            const res = await fetchApiKeys();
            setKeys(res.apiKeys);
            setAvailableScopes(res.availableScopes?.length ? res.availableScopes : ALL_SCOPES);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load tokens.");
        }
    }

    useEffect(() => {
        void load();
    }, []);

    function toggleScope(scope: string) {
        setScopes((prev) => {
            const next = new Set(prev);
            if (next.has(scope)) {
                next.delete(scope);
            } else {
                next.add(scope);
            }
            return next;
        });
    }

    async function submit(event: SyntheticEvent) {
        event.preventDefault();
        setError(null);
        setFreshToken(null);
        setCopied(false);

        if (scopes.size === 0) {
            setError("Pick at least one scope.");
            return;
        }

        setBusy(true);
        try {
            const res = await createApiKey({ name: name.trim(), scopes: [...scopes] });
            setFreshToken(res.token);
            setName("");
            setScopes(new Set(["read"]));
            await load();
        } catch (e) {
            setError(
                e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : "Minting failed."
            );
        } finally {
            setBusy(false);
        }
    }

    async function remove(id: number) {
        if (!window.confirm("Revoke this token? Anything using it stops working immediately.")) {
            return;
        }
        setBusy(true);
        try {
            await deleteApiKey(id);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Revoke failed.");
        } finally {
            setBusy(false);
        }
    }

    async function toggleActive(key: ApiKeySummary) {
        setBusy(true);
        try {
            await setApiKeyActive(key.id, !key.active);
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Update failed.");
        } finally {
            setBusy(false);
        }
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard can be unavailable; the text is still selectable.
        }
    }

    const openApiUrl = `${BASE}/api/v1/openapi.json`;

    return (
        <div className="px-4 py-4">
            <div className="mb-4 flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={onClose}>
                    ← All monitors
                </Button>
                <h1 className="text-base font-semibold">Agents</h1>
                <span className="text-xs text-quiet">
                    Tokens are bearer credentials. Anyone holding one has its scopes.
                </span>
            </div>

            {error ? (
                <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
            ) : null}

            {freshToken ? (
                <div className="mb-4 rounded-md border border-warn/40 bg-warn/10 p-3">
                    <div className="mb-1 text-xs font-semibold text-warn">
                        Copy this token now. It will never be shown again.
                    </div>
                    <div className="flex items-center gap-2">
                        <code className="tnum flex-1 truncate rounded bg-surface-2 px-2 py-1.5 text-xs">
                            {freshToken}
                        </code>
                        <Button size="sm" variant="outline" onClick={() => void copy(freshToken)}>
                            {copied ? "Copied" : "Copy"}
                        </Button>
                    </div>
                </div>
            ) : null}

            <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2">
                <form onSubmit={submit} className="rounded-md border border-border bg-card p-4">
                    <h2 className="mb-3 text-sm font-semibold">New agent token</h2>

                    <label className="mb-3 block">
                        <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="ci-runner"
                            required
                        />
                    </label>

                    <div className="mb-1 text-xs font-medium text-muted-foreground">Scopes</div>
                    {availableScopes.map((scope) => (
                        <label key={scope} className="mb-1 flex cursor-pointer items-start gap-2 text-sm">
                            <Checkbox
                                checked={scopes.has(scope)}
                                onChange={() => toggleScope(scope)}
                                className="mt-0.5"
                            />
                            <span>
                                <span className="font-mono text-xs">{scope}</span>
                                <span className="block text-[11px] text-quiet">{SCOPE_HELP[scope] ?? ""}</span>
                            </span>
                        </label>
                    ))}

                    <Button type="submit" disabled={busy} className="mt-3">
                        {busy ? "Minting…" : "Mint token"}
                    </Button>
                </form>

                <div className="rounded-md border border-border bg-card p-4">
                    <h2 className="mb-3 text-sm font-semibold">Point an agent here</h2>
                    <p className="mb-2 text-xs text-quiet">
                        An agent with the OpenAPI document and a token can figure out the rest.
                    </p>
                    <div className="mb-2 flex items-center gap-2">
                        <code className="tnum flex-1 truncate rounded bg-surface-2 px-2 py-1.5 text-xs">
                            {openApiUrl}
                        </code>
                        <Button size="sm" variant="outline" onClick={() => void copy(openApiUrl)}>
                            Copy
                        </Button>
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                        <code className="tnum flex-1 truncate rounded bg-surface-2 px-2 py-1.5 text-xs">
                            {`curl -H "Authorization: Bearer <token>" ${BASE}/api/v1/health`}
                        </code>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void copy(`curl -H "Authorization: Bearer <token>" ${BASE}/api/v1/health`)}
                        >
                            Copy
                        </Button>
                    </div>
                    <p className="text-[11px] text-quiet">
                        Give agents <span className="font-mono">read</span> unless they genuinely need to mutate
                        monitors. Never hand out <span className="font-mono">publish</span> to anything unattended.
                    </p>
                </div>
            </div>

            <h2 className="mb-2 text-[11px] uppercase tracking-wide text-quiet">
                Tokens <span className="tnum">({keys.length})</span>
            </h2>

            {keys.length === 0 ? (
                <p className="text-sm text-quiet">No tokens yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="py-2 pr-4 font-medium">Name</th>
                                <th className="py-2 pr-4 font-medium">Scopes</th>
                                <th className="py-2 font-medium">Status</th>
                                <th className="py-2 pr-4 text-right font-medium">Created</th>
                                <th className="py-2 pr-4 text-right font-medium" />
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map((key) => (
                                <tr key={key.id} className="border-b border-border/60 last:border-0">
                                    <td className="py-2 pr-4 font-medium">{key.name}</td>
                                    <td className="py-2 pr-4">
                                        <span className="flex gap-1">
                                            {key.scopes.map((s) => (
                                                <Badge key={s} tone="neutral">
                                                    {s}
                                                </Badge>
                                            ))}
                                        </span>
                                    </td>
                                    <td className="py-2 whitespace-nowrap">
                                        <Badge
                                            tone={
                                                key.status === "active"
                                                    ? "up"
                                                    : key.status === "expired"
                                                      ? "degraded"
                                                      : "neutral"
                                            }
                                        >
                                            <span className="size-1.5 rounded-full bg-current" />
                                            {key.status}
                                        </Badge>
                                        {!key.active && key.status !== "expired" ? (
                                            <span className="ml-2 text-[11px] text-quiet">disabled</span>
                                        ) : null}
                                    </td>
                                    <td className="tnum py-2 pr-4 text-right text-xs text-quiet">
                                        {key.createdDate ? key.createdDate.slice(0, 10) : "—"}
                                    </td>
                                    <td className="py-2 pr-4 text-right">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => void toggleActive(key)}
                                        >
                                            {key.active ? "Disable" : "Enable"}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => void remove(key.id)}
                                            className="text-destructive"
                                        >
                                            Revoke
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
