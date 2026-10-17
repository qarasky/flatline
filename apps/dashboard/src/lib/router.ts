import { useEffect, useState } from "react";

/**
 * Minimal path router.
 *
 * The dashboard has three top-level routes (the table, the board and
 * the chrome-free kiosk board, each board optionally group-scoped like
 * /superboard/kiosk/work). A routing library would be more machinery than
 * the problem needs, and this keeps the dependency list where it is.
 *
 * Vite's dev server and `vite preview` both fall back to index.html for
 * unknown paths, so deep links work without server configuration.
 */

/**
 * Normalised current path: no trailing slash, never empty.
 * @returns Path such as "/" or "/superboard/kiosk"
 */
export function currentPath(): string {
    const path = window.location.pathname.replace(/\/+$/, "");
    return path === "" ? "/" : path;
}

/**
 * Subscribe to browser navigation (back/forward and programmatic).
 * @returns The current path, re-rendering on change
 */
export function usePath(): string {
    const [path, setPath] = useState(currentPath);

    useEffect(() => {
        const onChange = () => setPath(currentPath());
        window.addEventListener("popstate", onChange);
        return () => window.removeEventListener("popstate", onChange);
    }, []);

    return path;
}

/**
 * Navigate without a full page load.
 * @param to Absolute path to push, e.g. "/superboard"
 */
export function navigate(to: string): void {
    if (currentPath() === to) {
        return;
    }

    window.history.pushState(null, "", to);
    // pushState does not fire popstate, so announce it ourselves and let
    // usePath pick the change up.
    window.dispatchEvent(new PopStateEvent("popstate"));
}
