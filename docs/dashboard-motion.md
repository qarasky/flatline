# Dashboard motion

How and when the operator UI (the admin sections of the [web app](dashboard.md))
animates. Written from published guidance (Atlassian, Carbon, Nielsen Norman
Group, Emil Kowalski, WCAG 2.2, motion.dev, web.dev); claims tagged _(ours)_
are Flatline's own calls, not sourced rules. The Superboard keeps its own
behaviour and is not covered here.

## Principles

- Motion explains change: where a row went, that a press registered, that a group
  opened, that a monitor changed state. It is never decoration, and it never slows
  work down or delays information.
- Almost everything is _productive_ motion: small, quick, unobtrusive. Expressive
  motion is reserved for rare moments (Carbon).
- Do not animate what people see dozens of times a day, or what keyboard users
  trigger repeatedly (`j`/`k`, focus moves, hovers beyond a colour fade).
- Peripheral movement pulls attention involuntarily (NN/g). On a screen that is
  watched all day, a static change is often the calmest one.
- The effect of an action starts within about 100 ms.

## Timings and curves

Tokens and the pure decisions behind them live in `apps/web/lib/motion.ts`
(tested in `apps/web/__tests__/ported/motion.test.mjs`). It imports no
animation library: the web app animates with CSS (Tailwind transitions,
`tw-animate-css` for the shadcn dialogs, sheets, menus and tooltips, and a few
keyframes in `app/globals.css`), and the TypeScript side uses the tokens for
its decisions.

| Token  | Value                              | Use                                                 |
| ------ | ---------------------------------- | --------------------------------------------------- |
| `fast` | 100 ms                             | Hover and press colour, small state flips           |
| `base` | 180 ms                             | Most enters, row highlight, small expand            |
| `slow` | 240 ms                             | Sections appearing, panes, larger expand, toasts    |
| exit   | about 60% of enter                 | Everything leaves faster than it arrives            |
| ease   | ease-out                           | Enter, exit, anything the user triggers             |
| move   | ease-in-out                        | Things already on screen that move                  |
| spring | `bounce: 0`, `visualDuration` 0.25 | Reorder, side pane, drag release (never overshoots) |

Carbon's productive curves are the reference: standard `0.2, 0, 0.38, 0.9`,
entrance `0, 0, 0.38, 0.9`, exit `0.2, 0, 1, 0.9`. Never ease-in. Never start from
`scale(0)` (start at 0.9 or above).

Where the tokens are used today:

| Token or function   | Used by                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `LIVE_BATCH_MS`     | `components/board/board-data.tsx`: live beats are applied in one render per 250 ms.             |
| `planCues`          | `board-data.tsx`: per-row highlights, or one summary cue when more than 6 rows change at once.  |
| `HIGHLIGHT_MS`      | `board-data.tsx`: how long a cue lasts; the row flash itself is `.board-flash` (900 ms) in CSS. |
| `shouldHoldReorder` | `components/monitors/monitors-board.tsx`: a status-driven reorder waits (rule 7 below).         |
| `isCalm`            | `hooks/use-idle-calm.ts`: after 5 minutes without input, row flashes and fresh-cell fades stop. |

The duration, curve and spring values are not imported by components yet; the
CSS uses the same numbers (row background 100 ms, strip cells 180 ms). Use the
tokens when motion needs a value in TypeScript, and the same numbers in CSS.

## What to use where

| Interaction                  | Motion                                                                     | Notes                                                 |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Hover, focus, press          | Colour/background fade, `fast`. Press scale 0.97 on buttons only           | Never scale or move rows on hover                     |
| Row enter/exit (filter, new) | Opacity, tiny y-offset at most                                             | Existing rows never animate on load                   |
| List reorder                 | Position only, spring                                                      | Only rows that can move; see live rules               |
| Group expand/collapse        | Height + opacity, `base` (`slow` for large groups); chevron rotates        |                                                       |
| Attention item in/out        | Fade and height, `slow`; no slide over content being read                  |                                                       |
| Status change                | Dot/word colour transition `base`, plus one short highlight that fades out | Always with a persistent icon or word                 |
| New beat in the strip        | Shift by one cell or fade the new cell in, once per beat _(ours)_          | Not on a resnapshot                                   |
| Detail pane                  | Slide + fade; sheet on narrow screens                                      | Dismiss is faster; `Esc` closes                       |
| Tooltip, popover             | Fade + scale 0.97, about 125 ms, origin at the trigger                     | Skip the animation if another tooltip is already open |
| Toast                        | Fade with a short slide, `slow`; exit faster                               |                                                       |
| Route change                 | None, or an opacity crossfade of at most 150 ms _(ours)_                   |                                                       |
| Loading                      | Static skeleton, fade to content                                           | No looping shimmer on a wall screen                   |
| Counters and numbers         | Swap instantly _(ours)_                                                    | Optionally one brief flash when a value changed       |

## Rules for a live, streaming board

These are our synthesis; the sources cover the general principle, not streaming.

1. **Animate meaningful change only:** a status change, a row entering or leaving
   the attention section, a group toggle, a filter result changing. A heartbeat
   with no status change, a ping update or a "checked" age never animates.
2. **Data first, motion second.** A new status paints immediately (new colour, word
   and icon). The highlight is layered on top; nothing waits for an animation.
3. **Coalesce.** Apply live events in one render per frame or per about 250 ms, so
   one reconcile drives all animations.
4. **Cap concurrency.** When more than 6 rows change in one batch, skip per-row
   highlights and show one group-level cue instead (the status summary shows how
   many changed). Tune the number (`LIVE_BURST_CAP`) in `motion.ts`.
5. **No stagger on live data.** Stagger delays information. At most on first load,
   with a total budget under 200 ms.
6. **Highlights decay and never loop.** One pulse, under one second. No infinite
   pulse on a down row; a down row is shown by its persistent dot, word and strip.
7. **Do not reorder under the pointer.** While the pointer is over the list, a
   selection exists or a menu is open, a status-driven reorder waits (the row keeps
   its place and shows its new state) and applies when the pointer leaves.
8. **Wall screens.** After 5 minutes without input, non-essential motion switches
   off (highlights shorten to a colour change). A "pause live updates" control exists
   (**Pause** on Monitors; WCAG 2.2.2: auto-updating content must be pausable).

## Accessibility

- `prefers-reduced-motion: reduce` cuts every animation and transition to
  effectively zero (`app/globals.css`), and components add
  `motion-reduce:transition-none` where a transition would move something.
  Colour and state changes still happen instantly: do not strip feedback
  altogether; swap movement for a fade or an instant change.
- No flashing: never more than three flashes in any second (WCAG 2.3.1).
- Status is never carried by motion alone, nor by colour alone: dot plus word or
  icon shape, always.
- Everything works with motion off.

## Implementation notes

- Prefer CSS: Tailwind `transition-*` utilities with the token durations, the
  `tw-animate-css` enter/exit classes the shadcn components already use, and a
  named keyframe in `app/globals.css` for anything bespoke. There is no
  animation library in the bundle; adding one (for layout animation) is a
  deliberate choice, kept off the Superboard and status pages.
- Animate `transform` and `opacity`. Animating `height` is costly: do it only for
  group and section expansion, in isolation.
- Borders on moving elements cause layout recalculation; prefer shadows,
  background or pseudo-element lines (the board's row separators are `::after`
  lines).
- A highlight that must restart on each change is keyed by a sequence number
  (`monitor-row.tsx` re-keys its `.board-flash` span), so CSS replays it.
- Measure with 100+ monitors under 4x CPU throttling before widening the use of
  any animation on rows.

## Checklist

1. Every animation has a functional reason.
2. Frequent interactions stay under 150 ms and are colour-only on rows.
3. Ease-out in, faster out, no ease-in, no overshoot.
4. New data is visible instantly.
5. One short, fading highlight per status change; no loops.
6. Live events are coalesced; heartbeats without a change do not animate.
7. Mass changes collapse to one cue; no stagger on live data.
8. Reorder waits while the pointer is over the list.
9. Layout animation is selective.
10. Status always has a non-motion signal.
11. Reduced motion swaps movement for fades and keeps feedback.
12. Wall screens calm down after idle, and live updates can be paused.
