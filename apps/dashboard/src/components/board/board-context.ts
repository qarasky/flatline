import { createContext, useContext } from "react";
import type { MonitorSummary } from "@/lib/api";
import type { Density } from "@/lib/board-url";
import type { Strip } from "@/lib/heartbeat-strip";

/** Stable callbacks (identity never changes), so memoised rows are not re-rendered by them. */
export interface BoardActions {
    openMonitor: (id: number) => void;
    toggleSelect: (id: number) => void;
    toggleGroup: (id: number) => void;
    openMenu: (monitor: MonitorSummary, x: number, y: number) => void;
}

export interface BoardView {
    density: Density;
    calm: boolean;
    strips: Map<number, Strip>;
    selected: Set<number>;
    collapsed: Set<number>;
    /** Groups are forced open while a filter or search is active so matches are never hidden. */
    forceOpen: boolean;
    openId: number | null;
    menuId: number | null;
    cursorId: number | null;
    /** Rows highlighted by the latest status-change batch. */
    cueRows: Set<number>;
    cueSeq: number;
    now: number;
}

export const BoardActionsContext = createContext<BoardActions | null>(null);
export const BoardViewContext = createContext<BoardView | null>(null);

export function useBoardActions(): BoardActions {
    const value = useContext(BoardActionsContext);
    if (!value) {
        throw new Error("BoardActionsContext missing");
    }
    return value;
}

export function useBoardView(): BoardView {
    const value = useContext(BoardViewContext);
    if (!value) {
        throw new Error("BoardViewContext missing");
    }
    return value;
}
