/**
 * Motion tokens and the pure decisions behind them.
 *
 * Mirrors docs/dashboard-motion.md. Components import these instead of using
 * literals. Nothing here imports the `motion` library at runtime, so the
 * decisions stay unit-testable in plain node and the library stays in the
 * dashboard route's chunk.
 */

type Bezier = [number, number, number, number];

/** Durations in seconds. */
export const duration = {
    /** Hover and press colour, small state flips. */
    fast: 0.1,
    /** Most enters, row highlight, small expand. */
    base: 0.18,
    /** Sections appearing, panes, larger expand, toasts. */
    slow: 0.24,
} as const;

/** Everything leaves faster than it arrives. */
export const EXIT_FACTOR = 0.6;

/** Carbon's productive curves; never ease-in. */
export const curve = {
    standard: [0.2, 0, 0.38, 0.9] as Bezier,
    entrance: [0, 0, 0.38, 0.9] as Bezier,
    exit: [0.2, 0, 1, 0.9] as Bezier,
};

/** Reorder, side pane, sheet: never overshoots. */
export const spring = { type: "spring" as const, bounce: 0, visualDuration: 0.25 };

/** Never start from scale(0). */
export const POP_SCALE = 0.97;

/** Enter / exit transitions for a duration token. */
export function enterTransition(seconds: number = duration.base) {
    return { duration: seconds, ease: curve.entrance };
}
export function exitTransition(seconds: number = duration.base) {
    return { duration: seconds * EXIT_FACTOR, ease: curve.exit };
}

/** Live events are applied in one render per this many milliseconds. */
export const LIVE_BATCH_MS = 250;
/** More status changes than this in one batch collapse to one group cue. */
export const LIVE_BURST_CAP = 6;
/** Without input for this long, non-essential motion switches off. */
export const IDLE_CALM_MS = 5 * 60 * 1000;
/** A status highlight is one pulse under one second. */
export const HIGHLIGHT_MS = 900;
/** Tooltip/popover duration, about 125 ms. */
export const POPOVER_SECONDS = 0.125;

export interface CuePlan {
    /** Rows that get their own highlight. */
    rows: number[];
    /** One summary-level cue instead of per-row highlights. */
    group: boolean;
}

/**
 * Decide how a batch of status changes is announced.
 * @param changedIds Monitors whose status changed in this batch
 * @param cap Largest batch that still gets per-row highlights
 */
export function planCues(changedIds: number[], cap: number = LIVE_BURST_CAP): CuePlan {
    if (changedIds.length === 0) {
        return { rows: [], group: false };
    }
    if (changedIds.length > cap) {
        return { rows: [], group: true };
    }
    return { rows: changedIds, group: false };
}

/**
 * Whether a status-driven reorder must wait: the pointer is over the list, a
 * selection exists or a menu is open.
 */
export function shouldHoldReorder(state: {
    pointerOverList: boolean;
    selectionSize: number;
    menuOpen: boolean;
}): boolean {
    return state.pointerOverList || state.selectionSize > 0 || state.menuOpen;
}

/**
 * Whether the board should be in calm mode (wall screen, nobody there).
 * @param lastInputMs Time of the last pointer/key input
 * @param nowMs Current time
 */
export function isCalm(lastInputMs: number, nowMs: number, idleMs: number = IDLE_CALM_MS): boolean {
    return nowMs - lastInputMs >= idleMs;
}

/** Highlight length: none in calm mode (the colour change still happens). */
export function highlightDuration(calm: boolean): number {
    return calm ? 0 : HIGHLIGHT_MS / 1000;
}

/** A tooltip skips its enter animation when another one is already open. */
export function tooltipShouldAnimate(openTooltips: number): boolean {
    return openTooltips === 0;
}
