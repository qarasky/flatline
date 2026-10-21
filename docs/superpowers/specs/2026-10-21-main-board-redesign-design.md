# Main board redesign — design

The main board is the monitor table at `/` (`apps/dashboard/src/components/Dashboard.tsx`).
The Superboard (wall cards, `/superboard`) is **out of scope and must not change**,
including its components, styles and behaviour.

## Why

The operator finds the board dense and hard to scan: seven columns carry the same
visual weight, a down monitor is one red badge in the middle of identical rows,
it is hard to tell rows apart and to find a needed fact, collapsed groups lose
their health, controls are always visible, and nothing animates. A comparison of
Uptime Kuma, Gatus, Better Stack, UptimeRobot, Checkly, Datadog, Instatus and
Grafana (October 2026) gave the direction below.

## Goals

1. Answer "what needs me right now?" first.
2. Make any row identifiable and scannable at a glance, with calm, low-density rows.
3. Keep every existing capability (tree, bulk actions, search, group menu, monitor form, live updates).
4. Motion that explains change (a status flip, a group opening, a section appearing) and is never tiring.

## Non-goals and anti-goals

- No change to the Superboard, the status pages, the backend check engine, or the SSE contract.
- No component library and no routing library. `motion` (Framer Motion, `motion/react`) is the only new dependency.
- Anti-goals: motion that delays or hides outage information; status shown by colour or motion alone;
  a permanent filter side panel; two competing ways to organise monitors.

## The design

### Layout (top to bottom)

1. **Header:** brand, search (`/` focuses), filter button with an active-count badge, saved views, density toggle
   (comfortable/compact), actions (New monitor, New group, Superboard, Agents, Disconnect).
2. **Status summary:** one calm banner with the fleet state in words ("All 33 monitors up" / "2 monitors need attention"),
   plus up/down/pending/maintenance/paused counts that are also filters.
3. **Needs attention** (pinned): shown only when something is wrong; hidden otherwise. Items:
   down, pending (retrying), flapping (several status changes in the last hours), stale push (no beat for much longer than its interval),
   agent warnings, and overdue/failed backups where the data is available. Each item shows what is wrong and for how long, and opens the monitor in one click.
4. **The list:** the existing group tree. Group rows carry a worst-of dot and up/down counts so a collapsed group still shows trouble.
5. **Detail pane:** opening a monitor shows its detail beside the list (a sheet on narrow screens) so the list position is not lost. `Esc` closes it.

### Row anatomy

`[status dot] name  ·  24 h heartbeat strip  ·  uptime 24h`. The target URL sits under or beside the name in quiet text.
Ping, last check and type appear on hover/focus and in the detail pane. Selection checkbox and the `⋯` menu appear on hover or focus,
or whenever anything is selected. Selected, focused and hovered rows have distinct states; the open row has an accent edge.
Status is a dot **and** a word or icon shape, never colour alone.

### Heartbeat strip

48 buckets × 30 minutes = 24 h, each bucket coloured by its worst beat (down > pending > maintenance > up), empty buckets muted.
Hover shows the bucket's time range, beat count and failed beats. Data comes from a new bulk backend endpoint (below);
live `heartbeat` events update the newest bucket locally, and a resnapshot reloads the strips.

### Sort, filter, views, keyboard

- Default sort: **worst first** (down, pending, then the rest), then the group order the operator already set. Other sorts: name, uptime, last change.
  Inside the tree, sorting applies within each group; groups containing a worse child rise.
- Filters: status chips, type, tags, a "needs attention" preset. A group matches when any child matches. Filters and sort live in the URL query and
  can be saved as named views (localStorage); one view can be the default.
- Keyboard: `/` search, `j`/`k` move, `Enter` open, `x` select, `Esc` close/clear. Never steal keys while typing.

### Backend addition

`GET /api/v1/monitors/heartbeat-strips?ids=1,2,3&hours=24&buckets=48` (token-scoped like the other monitor routes; ids optional = all, at most 200;
hours ≤ 168; buckets ≤ 120). Buckets are aligned to multiples of the bucket size since the Unix epoch, so the client can place a live beat without asking:

```json
{
  "ok": true,
  "hours": 24,
  "buckets": 48,
  "bucketSeconds": 1800,
  "start": "2026-10-21T10:30:00.000Z",
  "strips": { "7": [[1, 90, 0], null, [0, 90, 61]] }
}
```

Each bucket is `[worstStatus, beats, failedBeats]` (status codes as in heartbeats: 0 down, 1 up, 2 pending, 3 maintenance) or `null` for no data.
The last bucket is the one containing now. Cached on the server for a few seconds; one indexed range scan per monitor.

### Motion

Governed by `docs/dashboard-motion.md`. In short: `motion` with `LazyMotion`; animate only meaningful change (status flips, group expand/collapse,
sections entering/leaving, the detail pane, new beats); never every refresh; short, asymmetric timings; reduced-motion support everywhere;
many simultaneous flips are coalesced rather than animated one by one.

## Calls made without the operator (to confirm while reading)

- Strip window 24 h in 30-minute buckets, worst-of per bucket (not the last N raw beats, which at 20 s checks cover only ~20 minutes).
- "Flapping" = at least 4 status changes in the last 6 hours, derived from the strip buckets; "stale push" = no beat for more than 3× the monitor interval.
- Density toggle and saved views are stored per browser, not on the server.
- Detail opens in a side pane (≥ 1280 px) and as a full sheet below that.

## Left to the builder

Exact visual values within the existing palette (`src/index.css`); component split; empty and loading states; how agent warnings and backup health
are fetched cheaply (reuse existing bulk endpoints; list what is unavailable instead of adding new ones); keyboard-shortcut hint UI.
