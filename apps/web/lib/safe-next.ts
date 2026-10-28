import { HOME_PATH, SIGN_IN_PATH } from "@/lib/session";

/**
 * The page to return to after signing in, from an untrusted `next` value.
 * Only a path on this site is kept: anything that a browser could read as
 * another origin (`//host`, `/\host`, a scheme) or that points back at the
 * sign-in page falls back to the home page.
 */
export function safeNext(raw: string | null | undefined): string {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
        return HOME_PATH;
    }
    const path = raw.split(/[?#]/, 1)[0];
    if (path === SIGN_IN_PATH || path.startsWith(`${SIGN_IN_PATH}/`)) {
        return HOME_PATH;
    }
    return raw;
}
