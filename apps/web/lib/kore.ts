import type { AppNames } from "@qarasky/kore-ui";

/**
 * Kore platform constants for kore-ui's identity parts. The product is shown
 * as KoreMonitor (its former name, Flatline, survives only in technical
 * identifiers), so the switcher, account menu and sign-in screen get that
 * name through `names`.
 */
export const KORE_APP = "flatline" as const;
export const KORE_NAMES: AppNames = { flatline: "KoreMonitor" };

/** The cookie that remembers a collapsed sidebar ("false" = collapsed), read on the server. */
export const SIDEBAR_COOKIE = "sidebar_state";
