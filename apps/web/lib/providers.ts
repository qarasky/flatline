/**
 * Hosting provider catalog for monitor cards.
 *
 * A monitor's `provider` is a free-form string the server stores verbatim
 * (trimmed and lowercased): normally a domain ("ps.kz", "hetzner.com"), but a
 * short id ("hetzner", "digitalocean") works too. Known providers below get a
 * bundled, transparent logo served from the web root; anything else falls back
 * to the site's favicon, so a new provider needs data here, never a migration.
 *
 * The catalog is deliberately plain data. A future provider monitor type can
 * reuse it to know which API a provider id belongs to, instead of a second
 * provider list appearing somewhere else.
 */

/** A provider with a bundled logo. */
export interface ProviderInfo {
    /** Canonical id stored on the monitor. */
    id: string;
    /** Human label for pickers and tooltips. */
    label: string;
    /** Website the logo belongs to; the favicon fallback keys off this. */
    domain: string;
    /** Bundled transparent logo, relative to the web root. */
    logo: string;
}

/** A provider id resolved to something a card can render. */
export interface ResolvedProvider {
    id: string;
    label: string;
    /** Website used for the favicon fallback; null when the id is not a domain. */
    domain: string | null;
    /** Image URL, or null when there is nothing sensible to draw. */
    logo: string | null;
    /** True when this is not one of the bundled providers. */
    custom: boolean;
}

/**
 * Providers used in production. Keep logos transparent symbols: cards show
 * them inline with the title, with no badge or background behind them.
 */
export const PROVIDERS: readonly ProviderInfo[] = [
    { id: "ps.kz", label: "PS.kz", domain: "ps.kz", logo: "/providers/ps-kz.png" },
    { id: "hoster.kz", label: "Hoster.kz", domain: "hoster.kz", logo: "/providers/hoster-kz.svg" },
    { id: "hetzner", label: "Hetzner", domain: "hetzner.com", logo: "/providers/hetzner.png" },
    { id: "digitalocean", label: "DigitalOcean", domain: "digitalocean.com", logo: "/providers/digitalocean.svg" },
];

/** Alternate spellings that resolve to a bundled provider. */
const PROVIDER_ALIASES: Record<string, string> = {
    "hetzner.de": "hetzner",
    "hetzner.cloud": "hetzner",
    "www.hetzner.com": "hetzner",
};

/** Matches a bare hostname like "vultr.com" or "ps.kz". */
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Reduce any provider spelling to a comparable key: id, hostname or slug.
 *
 * Accepts a bare id, a domain, or a pasted URL ("https://hetzner.com/x"); a
 * leading "www." and any path are dropped so all spellings of one provider
 * agree on the same key.
 * @param value Raw provider value from a monitor or a form
 * @returns Lowercased key, or null for blank input
 */
export function providerKey(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const raw = value.trim().toLowerCase();
    if (raw === "") {
        return null;
    }

    try {
        const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
        const host = url.hostname.replace(/^www\./, "");
        if (host) {
            return host;
        }
    } catch {
        // Not URL-shaped (a label with spaces, a slug); fall through to raw.
    }

    return raw.replace(/^www\./, "");
}

/**
 * Favicon of an arbitrary site, for providers with no bundled logo.
 *
 * The browser loads this directly; a kiosk without internet simply renders
 * no logo rather than a broken image.
 * @param domain Site domain, e.g. "vultr.com"
 * @returns Favicon service URL
 */
export function faviconUrl(domain: string): string {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

/**
 * Resolve a monitor's provider to a renderable symbol.
 *
 * Known ids/domains/aliases return their bundled logo. An unrecognised value
 * that looks like a domain gets its favicon; an unrecognised slug resolves to
 * no logo at all (nothing to fetch), which the card treats as "no provider".
 * @param value Provider value from the monitor
 * @returns Resolved provider, or null when unset
 */
export function resolveProvider(value: unknown): ResolvedProvider | null {
    const key = providerKey(value);
    if (key === null) {
        return null;
    }

    const aliased = PROVIDER_ALIASES[key] ?? key;
    const known = PROVIDERS.find((p) => p.id === aliased || p.domain === aliased);
    if (known) {
        return { id: known.id, label: known.label, domain: known.domain, logo: known.logo, custom: false };
    }

    if (DOMAIN_PATTERN.test(key)) {
        return { id: key, label: key, domain: key, logo: faviconUrl(key), custom: true };
    }

    return { id: key, label: key, domain: null, logo: null, custom: true };
}

/**
 * Label for a provider value, falling back to the raw value when unknown.
 * @param value Provider value from the monitor
 * @returns Human label, or null when unset
 */
export function providerLabel(value: unknown): string | null {
    return resolveProvider(value)?.label ?? null;
}
