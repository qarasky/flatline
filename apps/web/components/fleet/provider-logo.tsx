"use client";

import { useEffect, useState } from "react";
import { resolveProvider } from "@/lib/providers";

/**
 * The provider's symbol shown before a card title.
 *
 * Deliberately bare: no tile, border or background, sized to the title's
 * font so it reads as a symbol rather than a badge. Only the bundled logos
 * are drawn: the web app loads nothing from outside, so a custom provider
 * (and a logo that fails to load) renders nothing at all, never an empty
 * gap or a broken image.
 * @param props.provider Monitor provider id (domain, URL or slug)
 * @param props.className Extra classes for positioning in the title line
 */
export function ProviderLogo({ provider, className }: { provider?: string | null; className?: string }) {
    const resolved = resolveProvider(provider);
    const [failed, setFailed] = useState(false);

    // A new provider means a new image to try.
    useEffect(() => setFailed(false), [resolved?.logo]);

    if (!resolved?.logo || resolved.custom || failed) {
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
