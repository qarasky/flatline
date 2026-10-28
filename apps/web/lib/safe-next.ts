import { HOME_PATH, SIGN_IN_PATH } from "@/lib/session";

/** A placeholder origin: a path that resolves anywhere else is not ours. */
const PROBE_ORIGIN = "http://flatline.invalid";

/**
 * The page to return to after signing in, from an untrusted `next` value.
 *
 * Only a path on this site is kept. The value is resolved the way a browser
 * would resolve it (the URL parser drops tab, CR and LF first, so `/\t/host`
 * is `//host`), and anything that leaves this origin, carries control
 * characters or backslashes, or points back at the sign-in page falls back to
 * the home page.
 */
export function safeNext(raw: string | null | undefined): string {
    if (!raw || !raw.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(raw)) {
        return HOME_PATH;
    }
    let url: URL;
    try {
        url = new URL(raw, PROBE_ORIGIN);
    } catch {
        return HOME_PATH;
    }
    if (url.origin !== PROBE_ORIGIN) {
        return HOME_PATH;
    }
    if (url.pathname === SIGN_IN_PATH || url.pathname.startsWith(`${SIGN_IN_PATH}/`)) {
        return HOME_PATH;
    }
    return url.pathname + url.search + url.hash;
}
