import { useEffect, useState } from "react";
import { resolveProvider } from "@/lib/providers";

/**
 * The provider's symbol shown before a card title.
 *
 * Deliberately bare: no tile, border or background, sized to the title's
 * font so it reads as a symbol rather than a badge. Known providers use a
 * bundled logo; a custom domain falls back to its favicon. When nothing
 * resolves — or the favicon fails to load, e.g. an offline kiosk — the
 * component renders nothing at all, never an empty gap or a broken image.
 * @param props.provider Monitor provider id (domain, URL or slug)
 * @param props.className Extra classes for positioning in the title line
 */
export function ProviderLogo({ provider, className }: { provider?: string | null; className?: string }) {
    const resolved = resolveProvider(provider);
    const [failed, setFailed] = useState(false);

    // A new provider means a new image to try.
    useEffect(() => setFailed(false), [resolved?.logo]);

    if (!resolved?.logo || failed) {
        return null;
    }

    return (
        <img
            src={resolved.logo}
            alt=""
            aria-hidden="true"
            title={resolved.label}
            loading="lazy"
            decoding="async"
            className={className ? `provider-logo ${className}` : "provider-logo"}
            onError={() => setFailed(true)}
        />
    );
}
