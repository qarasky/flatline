# Dashboard

The operator UI at `/` — a grouped monitor board with live status, the control
surface for monitors, groups and tokens, and the entry point to the Superboard
and the status pages. It is a React + Vite app in `apps/dashboard/`; the backend
serves the built output, so in production there is no separate frontend origin.

## Routes

| Path                                 | Shows                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| `/`                                  | Token gate, then the monitor board.                     |
| `/superboard`, `/superboard/kiosk/…` | The wall board ([superboard](superboard.md)).           |
| `/status/:slug`                      | A public status page ([status pages](status-pages.md)). |
| any other path                       | The dashboard, so a deep link never 404s.               |

The router is ~40 lines in `src/lib/router.ts` (path parsing in
`src/lib/routes.ts`); there is no routing dependency.

- **Code splitting.** `App.tsx` is only the router: the dashboard, the Superboard
  and the status page are separate chunks loaded with `React.lazy`, so a status
  page visitor never downloads the operator UI. The `motion` library lives in the
  dashboard chunk only.
- **Error boundaries.** Each route has its own (`RouteErrorBoundary`). On the
  kiosk board and public status pages — screens nobody is sitting at — an
  error is shown and the page reloads itself after 30 s. Operator routes show
  the error with _Try again_ and _Reload page_. A route chunk that fails to load
  (an old tab after a deploy) lands in the same place.
- **New deploys.** Every 5 minutes, when the tab becomes visible, and whenever
  the live stream reconnects, the app fetches `/index.html` uncached and
  compares its hashed entry script and stylesheet with the ones it is running.
  On a change the kiosk, status pages and an unauthenticated `/` reload
  themselves (waiting while someone is typing); operator routes show a "new
  version — Reload" prompt. Nothing on the backend is involved, and the dev
  server (unhashed assets) never triggers it.

## Signing in

`TokenGate` asks for one thing: the operator token. Pasting it stores it locally
and every request carries it as a bearer token. A 401 returns the app to the
gate; `Disconnect` clears the stored token.

### Sign in with a QR code

A screen without a keyboard (the wall TV) shows a QR code instead. Scan it with
a phone that is already signed in, name the screen, and tap **Approve**: the
screen signs itself in with its own operator token. That token appears in
**Agents** under the name you gave it, never expires, and is revoked there
without affecting any other device. The code lives five minutes and renews
itself; a denied or expired request is replaced by a fresh code. **Paste a
token instead** stays on every gate as the fallback. The QR URL uses
`FLATLINE_PUBLIC_URL` when it is set, otherwise the address the screen was
opened on, so set it when the phone cannot reach that address. See the
[design](superpowers/specs/2026-10-21-qr-sign-in-design.md).

There is no username and no password: tokens are the only credential, and every
token has full permission. The **Agents** panel mints additional named tokens
(shown once, then only their hash is stored) so an integration can have its own
revocable credential.

## The monitor board

Design: [main board redesign](superpowers/specs/2026-10-21-main-board-redesign-design.md).
Motion: [dashboard motion](dashboard-motion.md).

From top to bottom:

- **Header:** search (`/` focuses it), a **Filter** button with an active-count badge, **Views**,
  a comfortable/compact **density** toggle, **Pause** (live updates), and the actions: **Superboard**,
  **Agents**, **New group**, **New monitor**, **Disconnect**.
- **Status summary:** the fleet state in words ("All 33 monitors up" / "2 monitors need attention")
  and up / down / pending / maintenance / paused counts. The counts are status filters.
- **Needs attention:** shown only when something is wrong. Items: down, pending (retrying),
  flapping (at least 4 status changes in 6 h, read from the strip), a push monitor silent for more
  than 3x its interval, agent warnings and failed or overdue backups. Each shows what is wrong and
  for how long, and opens the monitor in one click. Agent warnings come from one bulk metrics read
  for push monitors and backups from `/api/v1/backup-agents`, both loaded with each live-stream
  snapshot (and on backup events); they are not polled, so they refresh on reconnect rather than
  on every beat. Muted items (an acknowledged outage, see
  [muting](superboard.md#muting-a-known-outage)) stay listed after the others with a dark red mark;
  the count leaves them out and shows `· N muted` beside it.
- **The list:** the group tree, following the same `parent`/`weight` ordering as the Superboard.
  A row is `[status dot] name (target in quiet text) | status word | 24 h strip | uptime`.
  Ping, last check and type replace the target text on hover or focus. The checkbox and the `⋯` menu
  appear on hover, focus, or whenever something is selected. Group rows show a worst-of dot and
  up/down counts, so a collapsed group still shows trouble. Status is a dot **and** a word, and the
  dot's shape differs per status. A muted down monitor (or a group whose down monitors are all
  muted) has a dark red dot and reads `Down · muted`.
- **Detail:** opening a monitor shows it beside the list at 1280 px and wider, and as a sheet below
  that. The open row keeps an accent edge, `Esc` closes it, and the monitor is in the URL (`?m=ID`).
  A down monitor offers **Mute** beside **Edit**; a muted one offers **Unmute** and says since when,
  or which server's mute covers it.

### The 24 h strip

48 half-hour buckets, each coloured by its worst beat (down, pending, maintenance, up; empty
buckets muted; down cells are also taller). Hovering shows the bucket's time range, check count and
failures. The data is one bulk request per snapshot,
`GET /api/v1/monitors/heartbeat-strips?ids=&hours=24&buckets=48`, with explicit ids in chunks of
200; live `heartbeat` events update the newest bucket locally, and a resnapshot reloads the
strips. If the endpoint is missing or fails, rows render without a strip and no error is shown.

### Sorting, filters and views

- **Sort:** worst first (default: down, pending, then the rest, then the group order you set), name,
  uptime (lowest first) or last change. Sorting applies inside each group, and a group holding a
  worse child rises. "Last change" comes from the strip and from flips seen live, so it is empty for
  monitors that did not change in the last 24 h.
- **Filters:** status chips, type, tags and a "needs attention" preset, plus search (name, URL,
  host, type; a matching group name keeps its whole group). A group is shown when any child
  matches, and groups open while a filter is active.
- **URL:** filters, sort and the open monitor live in the query string (`?status=down&sort=name&m=12`),
  so a board can be linked.
- **Saved views:** name the current filters and sort, apply them later, and mark one as the default
  (applied when the URL carries no board state). Views and the density choice are stored per browser.

### Keyboard

| Key       | Action                                                       |
| --------- | ------------------------------------------------------------ |
| `/`       | Focus search                                                 |
| `j` / `k` | Move down / up the rows                                      |
| `Enter`   | Open the monitor (toggle a group)                            |
| `x`       | Select the row for bulk actions                              |
| `Esc`     | Close the detail, then clear the selection, then the filters |

Shortcuts never fire while typing in a field, and `Esc` leaves menus and dialogs to close
themselves first.

### Bulk actions, menus and live updates

- Selecting rows shows a floating bar with **Pause**, **Resume**, **Delete** and **Clear**.
- Every group row and monitor row has a `⋯` menu (right-click works too): monitors get Rename and
  Move to group; groups get New subgroup, Rename, Move and Delete.
- Deleting a group offers two modes: children move up to the group's parent (so nothing is
  orphaned), or the whole subtree is deleted with its history.
- **Live updates** arrive over the shared SSE stream and are applied in one render per ~250 ms.
  **Pause** buffers them (a banner says so) and applies them on resume. While the pointer is over the
  list, a selection exists or a menu is open, status changes do not reorder the rows; the order
  catches up afterwards. After 5 minutes without input the board calms down (no highlights or
  layout animation). The motion rules are in [dashboard motion](dashboard-motion.md).

A tab holds **one** live stream however many views want it (`src/lib/live-hub.ts`):
the board, the monitor detail view and the Superboard subscribe to the shared
connection rather than opening their own (the backend allows 8 per token). On
connect, reconnect and `invalidate` every subscriber resnapshots; between those
the detail view appends each live beat to its recent-checks list instead of
refetching the monitor and 120 heartbeats.

## The monitor form

One form for every type. `Type` is `http`, `https`, `push`, `ping` or `group` —
the backend implements those five; upstream's other types were not ported. Fields
are shown per type, and anything the backend does not accept comes back in
`ignoredFields` rather than failing silently.

Worth knowing:

- **Interval** is the down watchdog: silence for longer than the interval starts
  the retry window. The form recommends `interval` ≥ 3× the agent's push
  interval, with `maxretries: 2` and `retryInterval: 180` for agent hosts, so a
  network blip reads as pending instead of paging.
- **Push token** is generated server-side for push monitors and can be rotated;
  the agent's config needs the new value.
- **Provider** is a free-form id (usually a domain) drawn as a logo on the
  Superboard card.
- **Advanced → Metric alert thresholds** sets the per-server CPU / RAM / disk
  percentages; empty disables that alert. Semantics are in
  [superboard](superboard.md#metric-threshold-alerts).
- **Websites** links a server to the sites it hosts, using the same picker as the
  board (HTTP/HTTPS targets only).

## The Agents panel

Lists every token with its created date, expiry and status, and lets you mint a
named token, disable one, re-enable it or delete it. A newly minted token is
displayed exactly once — there is no endpoint that returns it again. Prefer a
named token per integration so a leak can be revoked without disturbing the
others.

## Public status pages

The status page (`/status/:slug`, or a client's own domain at `/`) refreshes
every 30 s. Failure handling is deliberately conservative
(`src/lib/status-snapshot.ts`):

- Once a page has rendered, a failed refresh keeps it on screen with a
  **"Stale since HH:MM:SS"** banner and retries with backoff (2 s doubling to
  60 s, jittered); a recovered refresh clears the banner. A failed heartbeat
  request inside an otherwise good refresh keeps the previous bars rather than
  blanking them, and also shows the banner.
- On a client domain, the host is resolved with `resolve-host`. Only a
  successful answer of `slug: null` means "not a status domain" and shows the
  operator dashboard; a network error or 5xx is retried ("Could not reach the
  status server. Retrying…") and never shows the token gate.
- `404` (no such page) and `401` (password) are authoritative and replace the
  page.

## Look and feel

The palette is a warm near-black with a hot-orange accent, defined once as CSS
variables in `src/index.css` and consumed by the components; there is no
component library. Cards, dialogs and menus are hand-rolled, with `aria` labels,
Escape-to-close and focus handling, and every measurement is printed as a number
so the UI never relies on colour alone.

## Working on the frontend

```bash
cd apps/dashboard
npm ci
npm run dev        # http://localhost:3003, proxies /api and /agent to :3001
npm run typecheck  # tsc --noEmit
npm run build      # tsx -b + vite build into dist/
```

The dev server proxies API and agent-download requests to the backend
(`FLATLINE_DEV_BACKEND`, default `http://127.0.0.1:3001`), so the browser sees a
single origin exactly as it does in production. Tests for the pure presentation
modules live in `apps/dashboard/test/` and run from the repository root
(`npm run test:dashboard`). See [development](development.md).
