"use client";

import { useState } from "react";
import { Button, Card, Field, Input } from "@qarasky/kore-ui";

/**
 * Password prompt for a protected status page.
 *
 * Posts to the KoreMonitor API, which sets the page-scoped unlock cookie on
 * this origin; the parent then re-fetches with `credentials: include`.
 * Kept as a component rather than a page so the cookie lands on the origin
 * that actually serves the page.
 */
export function UnlockForm({ slug, onUnlocked }: { slug: string; onUnlocked: () => void }) {
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") ?? "");

        try {
            const response = await fetch(`/api/v1/status-pages/unlock/${encodeURIComponent(slug)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
                credentials: "include",
                redirect: "manual",
            });

            if (response.status === 401) {
                setError("That password isn't correct. Check it and try again.");
                setPending(false);
                return;
            }

            // 302 from the server means the cookie is set; reload the data
            // in place rather than reloading the page.
            onUnlocked();
        } catch {
            setError("Couldn't reach the status server. Check your connection and try again.");
            setPending(false);
        }
    }

    return (
        <div className="status-page">
            <div className="status-wrap">
                <Card className="mx-auto mt-[12vh] max-w-[380px] p-6">
                    {/* A real POST target: before scripts load, Enter must not put the password in a URL.
                        The API sets the unlock cookie and redirects back here. */}
                    <form
                        className="flex flex-col gap-4"
                        method="post"
                        action={`/api/v1/status-pages/unlock/${encodeURIComponent(slug)}`}
                        onSubmit={onSubmit}
                    >
                        <div>
                            <h1 className="text-title font-semibold tracking-[-0.01em]">This status page is private</h1>
                            <p className="mt-1 text-muted">Enter the password you were given.</p>
                        </div>
                        <Field label="Password" error={error}>
                            <Input type="password" name="password" autoComplete="current-password" autoFocus required />
                        </Field>
                        <Button type="submit" variant="primary" fullWidth loading={pending}>
                            {pending ? "Checking…" : "Unlock"}
                        </Button>
                    </form>
                </Card>
            </div>
        </div>
    );
}
