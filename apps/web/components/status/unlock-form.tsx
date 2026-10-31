"use client";

import { useState } from "react";

/**
 * Password prompt for a protected status page.
 *
 * Posts to the Flatline API, which sets the page-scoped unlock cookie on
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
                setError("That password is not correct.");
                setPending(false);
                return;
            }

            // 302 from the server means the cookie is set; reload the data
            // in place rather than reloading the page.
            onUnlocked();
        } catch {
            setError("Could not reach the status server.");
            setPending(false);
        }
    }

    return (
        <div className="status-page">
            <div className="wrap">
                <form className="unlock" onSubmit={onSubmit}>
                    <h1>This status page is private</h1>
                    <p className="sub">Enter the password you were given.</p>

                    {error ? <div className="error">{error}</div> : null}

                    <input
                        type="password"
                        name="password"
                        placeholder="Password"
                        autoComplete="current-password"
                        autoFocus
                        required
                    />
                    <button type="submit" disabled={pending}>
                        {pending ? "Checking…" : "Unlock"}
                    </button>
                </form>
            </div>
        </div>
    );
}
