/**
 * Kore platform constants for kore-ui's identity parts. The app is still
 * called Flatline (the KoreMonitor rename is separate), so the switcher,
 * account menu and sign-in screen get that name through `names`.
 */
export const KORE_APP = "flatline" as const;
export const KORE_NAMES = { flatline: "Flatline" } as const;

/** The cookie that remembers a collapsed sidebar ("false" = collapsed), read on the server. */
export const SIDEBAR_COOKIE = "sidebar_state";
