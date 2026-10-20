# Dashboard

The operator UI at `/` — a grouped monitor table with live status, the control
surface for monitors, groups and tokens, and the entry point to the Superboard
and the status pages. It is a React + Vite app in `apps/dashboard/`; the backend
serves the built output, so in production there is no separate frontend origin.

## Routes

| Path                                 | Shows                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| `/`                                  | Token gate, then the monitor table.                     |
| `/superboard`, `/superboard/kiosk/…` | The wall board ([superboard](superboard.md)).           |
| `/status/:slug`                      | A public status page ([status pages](status-pages.md)). |
| any other path                       | The dashboard, so a deep link never 404s.               |

The router is ~40 lines in `src/lib/router.ts` (path parsing in
`src/lib/routes.ts`); there is no routing dependency.

- **Code splitting.** `App.tsx` is only the router: the dashboard, the Superboard
  and the status page are separate chunks loaded with `React.lazy`, so a status
  page visitor never downloads the operator UI.
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

There is no username and no password: tokens are the only credential, and every
token has full permission. The **Agents** panel mints additional named tokens
(shown once, then only their hash is stored) so an integration can have its own
revocable credential.

## The monitor table

- Monitors are shown as a tree: group rows with subtree counts, children
  indented and collapsible, following the same `parent`/`weight` ordering the
  Superboard uses.
- Each row carries a status dot, the monitor name, its response time and when it
  was last checked. Group rows aggregate their children (worst-of; paused
  children ignored).
- **Search** filters as you type; `/` focuses the field.
- Selecting rows enables bulk actions: **Pause**, **Resume** and **Delete**.
- Header actions: **New monitor**, **New group**, **Superboard**, **Agents**.
- Every group row and monitor row has a `⋯` menu (right-click works too):
  monitors get Rename and Move to group; groups get New subgroup, Rename, Move
  and Delete.
- Deleting a group offers two modes: children move up to the group's parent (so
  nothing is orphaned), or the whole subtree is deleted with its history.

Status updates arrive over the SSE stream, so the table re-renders as checks
finish rather than polling.

A tab holds **one** live stream however many views want it (`src/lib/live-hub.ts`):
the table, the monitor detail view and the Superboard subscribe to the shared
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
