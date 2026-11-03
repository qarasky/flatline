# Web app

The operator UI, the Superboard and the public status pages: one Next.js app in
`apps/web/`. It runs as its own server (the `web` container, `node
apps/web/server.js` on port 3000) behind Caddy, which sends the backend's paths
to the backend and everything else here, so the browser sees one origin. The
backend serves no UI of its own. (This file keeps the name `dashboard.md` from
the Vite dashboard the app replaced, so links to it keep working.)

## Stack

- **Next.js 16, App Router, server rendering.** Pages render on the server
  with their data, then hydrate. The build is `output: "standalone"`, traced
  from the repository root so `packages/shared` (the status-page client and
  types) comes along.
- **Tailwind CSS 4 and kore-ui** (`@qarasky/kore-ui`, pinned to a release
  tarball in `apps/web/package.json`), the design system shared by every Kore
  app. Its `DESIGN.md` is the source of truth for tokens, layout, components
  and copy; KoreMonitor follows it and documents only what is specific to
  monitoring. `app/globals.css` imports `@qarasky/kore-ui/theme.css` and keeps
  only monitoring CSS (the monitor board, heartbeat strips, fleet meters,
  history charts, the wall board and status pages), written on kore-ui's
  variables (`var(--color-*)`). Dark only; status colours are kore-ui's
  `status-*` tokens, plus two app-only ones (`status-muted` for a muted down
  monitor, `status-critical` for a critical resource level).
- **The shell is kore-ui's:** `AppShell` with a collapsible sidebar (state in
  the `sidebar_state` cookie, ⌘B toggles it), search in the top bar (⌘K), the
  Kore app switcher and account menu (Kore ID account, other apps from
  `KORE_APP_URLS`, sign out), `PageHeader` with breadcrumbs, and `AuthScreen`
  for sign-in. The shell shows the product as **KoreMonitor** (kore-ui's
  default, pinned by the `names` override in `lib/kore.ts`); the rename from
  Flatline is display-only, so code and deployment identifiers keep the
  `flatline` name.
- **lucide** icons and **cmdk** for the ⌘K palette. Nothing loads from another
  host (Caddy's CSP forbids it): the font is bundled.
- **Vitest** for tests (`apps/web/__tests__/`). The old dashboard's pure
  modules were ported into `apps/web/lib/` with their tests in
  `__tests__/ported/`.

| Path                | What                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `app/`              | Routes. `app/(admin)/` holds the signed-in sections under one layout.                    |
| `components/`       | One folder per section (`monitors/`, `servers/`, …) plus shared pieces.                  |
| `components/ui/`    | Only `command.tsx`: cmdk styled with kore-ui tokens (kore-ui has no command palette).    |
| `lib/`              | Pure logic and the API clients (`lib/api.ts`, `lib/<section>-api.ts`); what tests cover. |
| `hooks/`            | Small client hooks (clock, media queries, idle calm).                                    |
| `proxy.ts`          | The optimistic sign-in gate (Next 16's "proxy", formerly middleware).                    |
| `next.config.ts`    | Standalone output, the build id, the dev rewrites of `/api` and `/agent`.                |
| `public/providers/` | Bundled hosting-provider logos for the Superboard.                                       |

## Routes

| Path                                              | Shows                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/`                                               | Signed in: Monitors. On a client domain the backend maps: that status page. Otherwise: sign-in.                 |
| `/sign-in`                                        | Kore ID sign-in, or a clear "no sign-in method configured" state.                                               |
| `/monitors`, `/monitors/<id>`                     | The monitor board (`?m=ID` peeks a monitor, `?new=1` opens New monitor); a monitor's own page.                  |
| `/attention`                                      | What needs a look.                                                                                              |
| `/servers`, `/servers/<id>`                       | Push monitors with live CPU, RAM and disk; a server's page.                                                     |
| `/backups`, `/backups/<id>`                       | Backup agents; an agent's page.                                                                                 |
| `/notifications`, `/tokens`, `/members`           | Telegram configs, operator API tokens, member accounts.                                                         |
| `/superboard`, `/superboard/<scope>`              | The wall board at a desk ([superboard](superboard.md)).                                                         |
| `/superboard/kiosk`, `/superboard/kiosk/<groups>` | The wall board on the wall; signed out, it shows the Kore ID sign-in.                                           |
| `/status/<slug>`                                  | A public status page ([status pages](status-pages.md)).                                                         |
| `/build`                                          | `{"build": "<id>"}`: the build this server runs (new-deploy detection).                                         |
| `/index.html`                                     | A stub for wall screens still running the old dashboard (see [carry-over](#carry-over-from-the-old-dashboard)). |

Signed out, only `/`, `/sign-in`, the kiosk, `/status/*`, `/build` and
`/index.html` open; anything else redirects to `/sign-in?next=<path>`
(`lib/gate.ts`). Old dashboard links survive: `/?m=12` goes to
`/monitors/12`, and `/?status=down&sort=name` carries its filters and sort to
`/monitors`.

## Signing in

**Kore ID is the only sign-in.** The page offers **Continue with Kore ID**, a
link to `GET /api/v1/auth/sso/start`; with `KORE_ID_ISSUER` unset it says that
no sign-in method is configured. The callback sets the backend's HttpOnly
`fl_session` cookie, which holds a server-side session id; no credential is
kept in the browser. The cookie is `Secure` when the request came in over
https (the tunnel's `X-Forwarded-Proto`, which Caddy trusts only from the
Docker host). Signing out follows the `ssoLogoutUrl` the backend returns. See
[sso.md](sso.md).

- **First run.** The first person to sign in through Kore ID becomes a full
  operator (auto-provisioning); there is no first-account screen or token file.
- **The gate.** `proxy.ts` only checks that the cookie exists. Server layouts
  check it for real (`requireOperator`, `GET /api/v1/auth/me`); a rejected
  session goes to `/sign-in?expired=1`.
- **One level of access.** Every account and every operator API token has full
  permission. **Tokens** mints named API tokens for integrations and machines;
  **Members** lists the accounts Kore ID provisioned and removes people (and
  optionally the tokens they made).

### Carry-over from the old dashboard

The Vite dashboard polled `/index.html` for a new build. `GET /index.html`
answers a stub naming a module entry the old build never had, so the old tab
sees a "new build" and reloads into this app. It then signs in with Kore ID
like every other browser; a token left in `localStorage` is not accepted.

## Data: server and browser

`lib/api.ts` is the one API client. On the server it calls the backend at
`API_URL` (10 s deadline) and forwards the visitor's cookies, so a page is
rendered as the signed-in person; in the browser it calls the same-origin
`/api/...` and adds `X-Flatline-CSRF: 1` to writes. Non-2xx answers throw an
`ApiError` with the API's error code, message and hint.

The admin layout (`app/(admin)/layout.tsx`) checks the session, loads the
monitor roster once for the first render and wraps every section in
`BoardDataProvider` (`components/board/board-data.tsx`), the sidebar, the ⌘K
palette and the update watcher. A section that needs more data reads it in its
own server component.

### Live updates

A tab holds **one** live stream however many views want it (`lib/live-hub.ts`):
the admin area's shared board data (which also feeds Attention and its sidebar
count), a monitor's detail, the Servers metrics and the Superboard subscribe
to the shared SSE connection to `/api/v1/events` rather than opening
their own (the backend allows 8 per token). On connect, reconnect and
`invalidate` every subscriber resnapshots; `backups` events reload only backup
data. Live beats are applied in one render per 250 ms (`lib/live-batch.ts`).
**Pause** on Monitors buffers them for the whole admin area (a banner says how
many are waiting) and applies them on resume.

### New deploys

Each production build bakes its id (`FLATLINE_BUILD_ID`, the commit in the
image; the build time otherwise) into the bundle, and `GET /build` answers the
id of the build the server runs (`lib/build-id.ts`). Every 5 minutes, when the
tab becomes visible and whenever the live stream reconnects, an open tab
compares the two. On a change the kiosk and status pages reload themselves
(waiting while someone is typing); admin pages and the desk Superboard show
**A new version of KoreMonitor is available — Reload / Later**. The dev server
has no build id, so it never triggers.

### Errors

An admin page that cannot render (almost always the backend restarting) says
so and retries on its own with backoff. The Superboard and status pages, which
nobody sits at, show what failed and reload themselves after 30 s.

## Sections

The sidebar lists the sections in order (`lib/nav.ts`); Superboard opens
outside the admin layout. `⌘K` / `Ctrl+K` (or Search in the sidebar) jumps to
any section, monitor or server, or runs New monitor, Open Superboard or Sign
out (`lib/commands.ts`).

### Monitors

Design: [main board redesign](superpowers/specs/2026-10-21-main-board-redesign-design.md).
Motion: [dashboard motion](dashboard-motion.md).

- **Header:** **Pause** (live updates) and **New monitor**. Below it the status
  summary (the fleet state in words and up / down / pending / maintenance /
  paused counts, which are status filters), search (`/` focuses it),
  **Filter** (status, type, tags, a "needs attention" preset), **Display**
  (sort and a comfortable/compact density) and **Views**.
- **The list:** the group tree, in the same `parent`/`weight` order as the
  Superboard. A row is `[status dot] name (target in quiet text) | status word
| 24 h strip | uptime`. Hairline guides run down the left of every nested
  level, so depth reads at a glance; top-level groups are the sections, with a
  rule above and a heavier header. A group row shows a worst-of dot, a
  proportional health bar (down, pending, maintenance, up, paused; the whole
  bar is described to screen readers) and the counts, so a collapsed group still
  shows trouble. The status word appears only when something is wrong (the dot
  alone says "Up"; its shape differs per status, and it carries an accessible
  label). A muted down monitor reads `Down · muted` with a dark red dot.
- **The 24 h strip:** 48 half-hour buckets coloured by their worst beat (down
  cells are also taller). One bulk request per snapshot,
  `GET /api/v1/monitors/heartbeat-strips?ids=&hours=24&buckets=48`, in chunks
  of 200 ids; live beats update the newest bucket. If it fails, rows render
  without a strip.
- **Sort:** worst first (default), name, uptime (lowest first) or last change,
  applied inside each group; a group holding a worse child rises.
- **URL and views:** filters, sort and the open monitor live in the query
  string (`?status=down&sort=name&m=12`), and the server renders the board as
  linked. Saved views (named filter and sort combinations, one the default)
  and the density are kept per browser.
- **Peek:** opening a monitor shows it beside the list at 1280 px and wider,
  and as a sheet below that, with `?m=ID` in the URL; `/monitors/<id>` is its
  own page. A down monitor offers **Mute** beside **Edit** (on a group it mutes
  the monitors down inside it); a muted one offers **Unmute**.
- **Menus and bulk actions:** every row has a `⋯` and right-click menu
  (monitors: Rename, Move to group; groups: New subgroup, Rename, Move,
  Delete). Deleting a group moves its children up to its parent unless "Also
  delete everything inside" is ticked. Checkboxes select rows for bulk
  **Pause**, **Resume** and **Delete**.
- **The form** (New monitor, `?new=1` with `&parent=ID` or `&newType=group`;
  Edit opens in place) renders each type's fields from data
  (`lib/monitor-schema.ts`) and sets which notifications a monitor alerts
  through. The backend implements `http`, `https`, `push`, `ping` and `group`;
  fields it does not accept come back in `ignoredFields`. Interval is the down
  watchdog: for agent hosts use at least 3× the push interval with
  `maxretries: 2` and `retryInterval: 180`. Push tokens are generated
  server-side and can be rotated; **Advanced → Metric alert thresholds** sets
  the per-server CPU / RAM / disk alerts
  ([superboard](superboard.md#metric-threshold-alerts)).

| Key       | Action                                                       |
| --------- | ------------------------------------------------------------ |
| `/`       | Focus search                                                 |
| `j` / `k` | Move down / up the rows                                      |
| `Enter`   | Open the monitor (toggle a group)                            |
| `x`       | Select the row for bulk actions                              |
| `Esc`     | Close the detail, then clear the selection, then the filters |

Shortcuts never fire while typing in a field (`lib/board-keys.ts`).

### The other sections

- **Attention** (`/attention`): down, pending, flapping (at least 4 status
  changes in 6 h), push monitors silent for more than 3× their interval, agent
  warnings and failed or overdue backups, each saying what is wrong and for
  how long. Muted items are listed last
  ([muting](superboard.md#muting-a-known-outage)); the count beside the
  sidebar entry leaves them out.
- **Servers** (`/servers`): every push monitor with live CPU, RAM and
  fullest-disk use and how fresh the numbers are. `/servers/<id>` adds the
  agent's report (with Clear warnings), load history, containers, linked
  websites, thresholds and the server's backups.
- **Backups** (`/backups`): the backup agents. An agent's page edits its
  settings, lists runs with downloads and recorded checks, and rotates or
  revokes its token (shown once). See [backup agent](backup-agent.md).
- **Notifications** (`/notifications`): the Telegram configs with the monitors
  using each. Editing one leaves the bot-token field empty; an empty field
  keeps the stored token.
- **Tokens** (`/tokens`): operator API tokens for scripts and machines, with
  who made each and when it was last used. A new token is shown once. They do
  not sign in a browser.
- **Members** (`/members`): the accounts Kore ID provisioned; remove one here
  when someone leaves. Access itself is granted in Kore ID's admin.

### Superboard and status pages

The Superboard ([superboard](superboard.md)) and the status pages have their
own full-screen layouts (no app shell) built from kore-ui components and
tokens. Status pages render on the server and load no admin code
([status pages](status-pages.md)).

## Adding a section

1. **The route:** `app/(admin)/<section>/page.tsx`, a server component that
   renders kore-ui's `PageHeader` (title, breadcrumbs, actions) and the section's client
   component. Under `(admin)` it gets the session check, the sidebar, the
   palette and the shared live data for free. Set `metadata.title`
   (`"<Section> · KoreMonitor"`).
2. **The data:** a `lib/<section>-api.ts` module over `api()` for the
   section's endpoints, usable from server and client components. Live data
   comes from `useBoardData()` or a `subscribeLive` subscriber, not a second
   stream.
3. **The components:** `components/<section>/`, built from kore-ui parts
   (never a local copy of something kore-ui has; compose missing pieces from
   its parts).
   Keep pure decisions (formatting, sorting, what a row says) in `lib/` so
   they test without a DOM.
4. **Navigation:** add the section to `NAV_SECTIONS` in `lib/nav.ts`; the
   sidebar and the ⌘K palette both read it.
5. **A public page** (no session) also needs its path in `isPublic` in
   `lib/gate.ts`, with a test in `__tests__/gate.test.ts`.
6. **Tests and docs:** Vitest tests in `__tests__/`, then this document and
   the matching one in `docs/`.

## Working on the web app

```bash
./dev.sh                 # backend :3001, web app :3003, mock fleet
npm run test:web         # Vitest
npm run typecheck:web    # tsc --noEmit
npm run build:web        # next build (standalone)
```

In development `next.config.ts` rewrites `/api` and `/agent` to the backend
(`API_URL`, default `http://127.0.0.1:3001`), so the browser sees one origin as
it does behind Caddy. See [development](development.md).
