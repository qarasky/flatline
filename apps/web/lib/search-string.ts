/**
 * A Next page's `searchParams` object as a `?a=1&b=2` string (or "" when
 * empty), so the board's URL parser reads the same thing on the server as
 * `location.search` gives it in the browser.
 */
export function toSearchString(params: Record<string, string | string[] | undefined>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            query.append(key, item);
        }
    }
    const text = query.toString();
    return text ? `?${text}` : "";
}
