/**
 * Board filter/sort/open state <-> URL query, and saved views.
 *
 * Only non-default values are written, so a plain board has a clean URL.
 */

import { EMPTY_FILTER, STATUS_KEYS, type FilterState, type SortKey, type StatusKey } from "./board-model";

export interface BoardQuery {
    filter: FilterState;
    sort: SortKey;
    /** Monitor open in the detail pane. */
    open: number | null;
}

const SORTS: SortKey[] = ["worst", "name", "uptime", "changed"];

function csv(value: string | null): string[] {
    return value
        ? value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
        : [];
}

/** Query keys that belong to the board (anything else in the URL is left alone). */
export const BOARD_KEYS = ["q", "status", "type", "tag", "attention", "sort", "m"];

export function parseBoardQuery(search: string): BoardQuery & { hasParams: boolean } {
    const params = new URLSearchParams(search);
    const status = csv(params.get("status")).filter((s): s is StatusKey => STATUS_KEYS.includes(s as StatusKey));
    const sort = params.get("sort");
    const open = Number(params.get("m"));
    return {
        filter: {
            q: params.get("q") ?? "",
            status: [...new Set(status)],
            types: csv(params.get("type")),
            tags: csv(params.get("tag")),
            attention: params.get("attention") === "1",
        },
        sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : "worst",
        open: Number.isInteger(open) && open > 0 ? open : null,
        hasParams: BOARD_KEYS.some((key) => params.has(key)),
    };
}

/** Serialise to a query string ("" or "?a=b"). `open` is omitted when null. */
export function serializeBoardQuery(query: BoardQuery, existing = ""): string {
    const params = new URLSearchParams(existing);
    for (const key of BOARD_KEYS) {
        params.delete(key);
    }
    const { filter } = query;
    if (filter.q.trim()) {
        params.set("q", filter.q.trim());
    }
    if (filter.status.length) {
        params.set("status", filter.status.join(","));
    }
    if (filter.types.length) {
        params.set("type", filter.types.join(","));
    }
    if (filter.tags.length) {
        params.set("tag", filter.tags.join(","));
    }
    if (filter.attention) {
        params.set("attention", "1");
    }
    if (query.sort !== "worst") {
        params.set("sort", query.sort);
    }
    if (query.open !== null) {
        params.set("m", String(query.open));
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}

export interface SavedView {
    id: string;
    name: string;
    filter: FilterState;
    sort: SortKey;
}

export interface SavedViews {
    views: SavedView[];
    defaultId: string | null;
}

export const VIEWS_KEY = "flatline.board.views";
export const DENSITY_KEY = "flatline.board.density";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadViews(storage: StorageLike): SavedViews {
    try {
        const raw = JSON.parse(storage.getItem(VIEWS_KEY) ?? "null");
        if (!raw || !Array.isArray(raw.views)) {
            return { views: [], defaultId: null };
        }
        const views: SavedView[] = [];
        for (const view of raw.views) {
            if (typeof view?.id !== "string" || typeof view?.name !== "string") {
                continue;
            }
            const parsed = parseBoardQuery(
                serializeBoardQuery({ filter: { ...EMPTY_FILTER, ...view.filter }, sort: view.sort, open: null })
            );
            views.push({ id: view.id, name: view.name, filter: parsed.filter, sort: parsed.sort });
        }
        const defaultId = views.some((v) => v.id === raw.defaultId) ? (raw.defaultId as string) : null;
        return { views, defaultId };
    } catch {
        return { views: [], defaultId: null };
    }
}

export function storeViews(storage: StorageLike, state: SavedViews): void {
    try {
        storage.setItem(VIEWS_KEY, JSON.stringify(state));
    } catch {
        // Storage can be unavailable; views just will not persist.
    }
}

/** Add (or replace by name) a view. */
export function addView(state: SavedViews, name: string, filter: FilterState, sort: SortKey): SavedViews {
    const clean = name.trim().slice(0, 40);
    if (!clean) {
        return state;
    }
    const existing = state.views.find((v) => v.name.toLowerCase() === clean.toLowerCase());
    const id = existing?.id ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const view: SavedView = { id, name: clean, filter: { ...filter, q: filter.q.trim() }, sort };
    const views = existing ? state.views.map((v) => (v.id === id ? view : v)) : [...state.views, view];
    return { ...state, views };
}

export function removeView(state: SavedViews, id: string): SavedViews {
    return {
        views: state.views.filter((v) => v.id !== id),
        defaultId: state.defaultId === id ? null : state.defaultId,
    };
}

export function setDefaultView(state: SavedViews, id: string | null): SavedViews {
    return { ...state, defaultId: id === null || state.views.some((v) => v.id === id) ? id : state.defaultId };
}

export type Density = "comfortable" | "compact";

export function loadDensity(storage: StorageLike): Density {
    try {
        return storage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
    } catch {
        return "comfortable";
    }
}
