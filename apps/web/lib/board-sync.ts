import { parseBoardQuery, serializeBoardQuery, type BoardQuery } from "@/lib/board-url";

/** The board state a query string holds, written one canonical way. */
function canonical(search: string): string {
    return serializeBoardQuery(parseBoardQuery(search));
}

/**
 * The board state to adopt when the URL changed under the board (a link to
 * the same page, the sidebar, the command palette), or null when the URL
 * still says what the board itself last wrote there. Keys that are not
 * board state (`new`, `parent`) never count.
 */
export function urlBoardChange(search: string, ownSearch: string): (BoardQuery & { hasParams: boolean }) | null {
    return canonical(search) === canonical(ownSearch) ? null : parseBoardQuery(search);
}
