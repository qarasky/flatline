/**
 * Names shared by the sign-in gate, the API client and the pages. The cookie
 * and header names must match the backend (`backend-rs/src/auth.rs`).
 */

/** The backend's session cookie; it holds a server-side session id. */
export const SESSION_COOKIE = "fl_session";

/** Header every cookie-authenticated write sends (value `1`). */
export const CSRF_HEADER = "X-Flatline-CSRF";

/** Where the old Vite dashboard kept the token, read once for migration. */
export const LEGACY_TOKEN_KEY = "flatline.token";

/** Where a signed-in operator lands by default. */
export const HOME_PATH = "/monitors";

export const SIGN_IN_PATH = "/sign-in";

/** Where an account changes its password, and must before anything else. */
export const PASSWORD_PATH = "/account/password";

/** Request header `proxy.ts` sets to the page's path and query for server layouts. */
export const PATH_HEADER = "x-flatline-path";
