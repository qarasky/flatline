# Admin panel: rewrite the frontend in Next.js

Date: 2026-10-28. Status: direction approved in conversation; written for the
builder.

## Why

The operator UI today is one screen. `/` is the monitor board, and everything
else hangs off it: the status summary, "Needs attention", the group tree, the
detail pane, the Agents (tokens) panel, the monitor form, the server menu and
every dialog (`apps/dashboard/src/components/Dashboard.tsx`, ~790 lines). The
operator finds it confusing and says it feels like "a simple dashboard". They
want it to feel like an **admin panel**: separate sections, each with its own
page, in the look and feel of **Plane** (makeplane/plane, the open-source
project tracker). The point is how Plane looks and behaves, not its feature
set.

The **Superboard** (the wall display) is liked as it is and keeps its design.

The operator also chose the stack: the frontend is rewritten in **Next.js with
server-side rendering, Tailwind CSS and shadcn components**. Kore (the
operator's file server, `qarasky/kore`, running on the same office host)
already uses this stack with a Go API and Caddy in front, so the deployment
follows Kore's pattern.

## Goals

- An admin panel with a Plane-style layout: a persistent left sidebar of
  sections, one page per section, dense lists, a quiet page header with
  breadcrumbs and actions, and a detail panel that opens beside a list.
- Every feature of today's operator UI is still there, in the right section.
- The Superboard and the kiosk look and behave as they do today.
- Public status pages render on the server (a visitor sees the page without
  waiting for a script), with today's failure handling.
- One brand: Kore's blue accent, Inter, dark surfaces.
- Same public address, same agent endpoints, same API. Hosts, agents and AI
  clients notice nothing.

## Non-goals

- **Status page administration.** The API has no endpoints to list, create or
  edit status pages (`docs/status-pages.md`, "Editing a page"). A Status pages
  section needs a backend surface first; that is a separate project. Public
  status pages are ported, not changed.
- New monitoring features, new monitor types, changes to alerting.
- A light theme. Dark only for now; tokens are structured so a light theme can
  be added later (builder's call how).
- Translations. English only, as today.
- Changing the Superboard's layout, card anatomy, pagination or kiosk
  behaviour.

## Anti-goals (a failure even if it works)

- It still feels like one dashboard: a home page that crams the summary, the
  list, the detail and the settings together.
- The wall TV has to be re-paired, or a kiosk shows a sign-in screen after the
  switch.
- An agent push, an agent self-update, a backup upload or an install script
  breaks, or needs a client host to change anything.
- The accent colour can be mistaken for a status. Brand blue must never read as
  "maintenance", and nothing brand-coloured may read as "down".
- External loads: fonts, scripts or images from a CDN. Everything is bundled,
  as in Kore.
- A status page visitor downloads the operator UI.

## Look and feel

**Plane, as the reference.** What to take from it:

- A left **sidebar** (about 240 px, collapsible to icons) with the product mark
  at the top, the sections, and the account/sign-out at the bottom.
- A thin **page header**: breadcrumbs on the left (`Monitors / Work / site.kz`),
  the page's actions and its Display/Filter controls on the right.
- **Lists, not cards.** Dense rows with hairline separators; secondary
  properties as small quiet pills on the right of a row; hover reveals row
  actions.
- A **peek panel**: opening an item from a list slides its detail in on the
  right, with the list still visible and in place. The item also has its own
  full page (deep link).
- **Create in a modal**, edit in the panel or the full page.
- A **command palette** (`⌘K` / `Ctrl+K`) to jump to any monitor, server or
  section and to run the main actions.
- Neutral greys, small radii, almost no shadows, the accent only on primary
  actions, the current item and focus.

**Brand.** From `qarasky/ai-docs` (`projects/kore/README.md`):

| Token           | Value     | Use                                       |
| --------------- | --------- | ----------------------------------------- |
| `bg`            | `#16181d` | Page background                           |
| `surface`       | `#1d2026` | Sidebar, panels, table headers            |
| `raised`        | `#23262d` | Menus, popovers, dialogs                  |
| `border`        | `#2c3038` | Hairlines                                 |
| `border-strong` | `#3a3f49` | Stronger dividers                         |
| `text`          | `#e6e8ee` | Primary text                              |
| `muted`         | `#8a8f9a` | Secondary text                            |
| `accent`        | `#5b8def` | Primary actions, current item, focus ring |
| `accent-hover`  | `#7aa3f2` | Accent hover                              |

- Type: **Inter**, bundled locally (as Kore), with the same fallbacks; mono
  stack as Kore's. Root size and density are the builder's call; Plane and Kore
  both sit around 13–15 px in lists.
- Radius about 6 px in the app. Focus: 2 px accent outline, 2 px offset.
- Motion: short, and off under `prefers-reduced-motion`
  (`docs/dashboard-motion.md` still applies where it makes sense).

**Status colours stay semantic and separate from the brand.** Up green, warning
amber, down red, muted dark red (`#8a3a3d`), as today. **Maintenance moves off
blue** (today `#4c8dff`, too close to the new accent); pick a colour clearly
distinct from the accent and from the other statuses (a violet is the obvious
candidate). Status is never shown by colour alone: a dot shape and a word, as
today.

**Logo.** Flatline has two marks (`ai-docs/projects/flatline/README.md`). Use
the cream pulse (`favicon.svg`) in the sidebar; its red-orange sibling must not
appear next to status colours. Picking a single canonical mark is out of scope.

## Information architecture

Sidebar sections, in order:

| Section           | Path                          | What it holds (today's source)                                                                                                                                                                         |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Attention**     | `/attention`                  | Today's "Needs attention" list as its own page, with a count badge in the sidebar (like Plane's inbox). Muted items after the rest.                                                                    |
| **Monitors**      | `/monitors`, `/monitors/[id]` | The group tree with statuses, 24 h strips, uptime, filters, sort, saved views, search, bulk actions, row menus, keyboard, mute.                                                                        |
| **Servers**       | `/servers`, `/servers/[id]`   | Push monitors that report metrics: a list with CPU / RAM / disk / agent version / freshness, and a detail page with history charts, containers, linked websites, agent warnings, provider, thresholds. |
| **Backups**       | `/backups`, `/backups/[id]`   | Backup agents and their runs, downloads, verification, token rotate/revoke.                                                                                                                            |
| **Notifications** | `/notifications`              | The Telegram notification configs (`/api/v1/notifications`): list, create, edit, delete, and which monitors use each (read-only here).                                                                 |
| **Tokens**        | `/tokens`                     | Today's Agents panel: list, mint (shown once), disable, enable, delete; device tokens from QR sign-in appear here.                                                                                     |
| **Superboard**    | `/superboard`                 | Opens the wall board full-screen (no sidebar).                                                                                                                                                         |

- `/` goes to **Monitors** for a signed-in operator. On a client's status
  domain `/` is that status page (see below).
- The status summary (counts by status) moves into the Monitors page header,
  where its counts stay clickable filters.
- The monitor form (create/edit, all five types) is reachable from Monitors and
  Servers. Its content and rules are unchanged (`docs/dashboard.md`, "The monitor
  form"), with one addition: a **notifications picker**, because today a
  monitor's notifications can only be set through the API
  (`notificationIDList` on monitor create/update). Links are edited there, and
  the Notifications page shows them. _(Builder check; settled by the writer.)_
- **The API may grow additively** where a page needs data the API does not
  return. Known case: no GET returns a monitor's notification links
  (`monitor_notifications` is write-only), so add them to the monitor read
  (or a notification's monitors to the notification read), with `openapi.json`
  and tests. No migrations are expected for this project. _(Writer's call.)_
- Everything the server menu on a Superboard card does today stays on the card
  (mute, clear warnings, history, edit).
- Old deep links keep working: `/?m=ID` redirects to `/monitors/ID`; board query
  parameters (`status`, `sort`) carry over to `/monitors`.

What is in which section is the operator's direction; exact columns, panel
layouts and copy are the builder's.

## Routes that keep their behaviour

| Path                                                             | Notes                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/superboard`, `/superboard/kiosk`, `/superboard/kiosk/<groups>` | Ported as they are: same cards, pagination, `rotate`/`perPage`, idle behaviour, menus, mute. Inherits Inter and the accent; nothing else changes.                                |
| `/status/<slug>` and client domains                              | Server-rendered. Host resolution, password gate, 30 s refresh, "Stale since" banner and backoff as in `docs/dashboard.md` "Public status pages". No operator code in its bundle. |
| `/device/...` (QR approve)                                       | Ported. The approve screen on the phone and the QR on the kiosk keep working.                                                                                                    |

## Signing in

Today the token lives in the browser's `localStorage` and every request carries
it as a bearer header. Server rendering cannot read `localStorage`, so the
browser session moves to a cookie.

- **Backend accepts a session cookie.** On `/api/v1` (and `/api/v1/events`), the
  backend accepts the operator token from an `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie when no `Authorization` header is present. Bearer
  tokens keep working exactly as today for the API, agents and AI clients.
- **Cookie-authenticated writes need CSRF protection.** A non-GET request
  authenticated by the cookie must prove it comes from this origin (an `Origin`
  check, a custom header, or both; builder's call). Bearer requests are
  unaffected.
- **Sign-in and sign-out** set and clear the cookie (a backend route or a Next
  route handler; builder's call). Paste-a-token and the QR flow both end in the
  cookie.
- **The cookie is long-lived** (a kiosk must stay signed in for months) and
  **carries the operator token itself**, so a token revoked in Tokens stops
  working through the cookie with no extra code, and no session table (and no
  migration) is needed. _(Writer's call.)_
- **Migration without re-pairing.** On the first visit after the switch, a
  browser that still has the old `localStorage` token exchanges it for the
  cookie silently and deletes it. The wall TV must come back signed in.
- A signed-out operator route redirects to a sign-in page; a signed-out kiosk
  shows the QR code, as today.
- **The wall TV switches over unattended.** The kiosk running today detects a
  new deploy by fetching `/index.html` and comparing its `/assets/index-<hash>.js`
  entry (`apps/dashboard/src/lib/build-version.ts`); Next has neither, so the old
  kiosk would never reload. The new app therefore answers `GET /index.html` with
  a stub whose entry script name differs from any old build, so a running old
  tab sees "new build", reloads, lands on the new app and runs the migration
  above. _(Builder check; writer's call.)_

## Live updates

- Pages render their first view on the server; the browser then takes over with
  the existing live stream (`/api/v1/events`, one shared connection per tab,
  `live-hub.ts` semantics: resnapshot on connect/reconnect/`invalidate`,
  batched applies, Pause on the monitor list).
- The Superboard and kiosk are almost entirely live; render them however is
  simplest (a client component is fine).
- The pure logic modules in `apps/dashboard/src/lib/` (attention, mute,
  board-model, heartbeat-strip, fleet-layout, live-state, status-snapshot, and
  the rest) are moved, not rewritten, together with their tests in
  `apps/dashboard/test/`.
- The new-deploy detection (reload the kiosk and status pages, prompt
  operators) must keep working in the Next build; how it detects a new build is
  the builder's call.

## Deployment

Follow Kore (`~/.t3/projects/kore`: `Caddyfile`, `docker-compose.yml`,
`web/Dockerfile`):

- **Three containers:** `caddy` (the only published one), `flatline` (the Rust
  backend, unchanged apart from the cookie auth, no longer published) and `web`
  (Next.js standalone server).
- **Caddy routes to Rust:** `/api/*`, `/agent/*`, `/healthz`,
  `/add-push-server.md`, `/llms.txt`, `/robots.txt`. Everything else goes to
  Next. SSE and backup chunk uploads/downloads must stream unbuffered
  (`flush_interval -1`) with no body size limit. The route list is derived from
  `backend-rs/src/api/mod.rs`; a check (test or script) must catch a backend
  path that Caddy would send to Next.
- **Same published port.** Caddy takes over `FLATLINE_BIND`/`FLATLINE_PORT`:
  on office that is `127.0.0.1:3001` (`.env` has `FLATLINE_PORT=3001`; checked
  2026-10-28), so the Cloudflare tunnel and the off-host `/healthz` probe are
  unchanged. Kore's Caddy already publishes `8080` on the same host; the two
  compose projects need distinct Docker subnets.
- The backups override (`docker/compose.backups.yaml`) keeps working, and both
  compose files are still passed on office.
- The `web` container gets resource limits like the others (`mem_limit`,
  `pids_limit`, log rotation, `stop_grace_period`); the office host is shared
  with Kore.
- Headers and indexing as Kore's Caddyfile does them: a CSP with no external
  hosts, `X-Robots-Tag noindex` on the operator UI. Status pages keep their
  current indexing rules (`docs/status-pages.md`, "Indexing").
- `dev.sh` starts the Next dev server on `:3003` with `/api` and `/agent`
  proxied to `:3001`, so local development stays one origin.
- **The public distribution moves to the same shape.** The root `compose.yaml`
  and `README.md` today promise one service on 3001 and a "Without Docker" path
  where the backend serves the built dashboard. Both switch to the
  three-container layout; "Without Docker" becomes a short note (run the
  backend, `next start`, and a proxy routing as above) rather than a supported
  one-binary mode. The Rust image stops bundling the dashboard, and
  `web::fallback` / `FLATLINE_WEB_DIST` are removed. _(Builder check; writer's
  call: Flatline has one operator and no other installs to keep.)_

## Order of work

1. Next app skeleton in the repo (`apps/web`), tokens, Inter, shadcn setup, the
   sidebar layout, cookie sign-in (backend + app) and the localStorage
   migration.
2. Monitors (list, peek, full page, form, bulk, keyboard, views, mute) and
   Attention.
3. Servers and Backups.
4. Superboard, kiosk, status pages and device sign-in, ported.
5. Notifications and Tokens.
6. Caddy and compose, `dev.sh`, docs; delete `apps/dashboard`; cut production
   over with the usual pre-release database backup.

Each step leaves the repository building. The old dashboard stays in the tree
only as a reference while the new app is built, and step 6 deletes it with
everything else listed under "No rollback".

## Constraints

- Repository rules in `AGENTS.md` apply: docs change with behaviour (rewrite
  `docs/dashboard.md`; update `docs/architecture.md`, `docs/deployment.md`,
  `docs/development.md`, `AGENTS.md` layout and checks tables), API routes in
  `openapi.json`, commit subjects `type(scope): summary`, no emoji, never push
  or deploy without the operator's go-ahead.
- Versions: Next.js 16 (App Router), React 19, Tailwind 4, matching Kore.
  shadcn components are installed into the repo and themed with the tokens
  above.
- The office container has `mem_limit: 1g` today; the new `web` container needs
  its own budget, and the host also runs Kore.
- The `@flatline/shared` package stays the source of shared types.
- Existing dashboard tests keep passing in their new home; the checks table in
  `AGENTS.md` names the new commands.

## No rollback

This is a full migration with no fallback, by the operator's decision. The
old dashboard (`apps/dashboard`), the Rust image's dashboard bundle,
`web::fallback`, `FLATLINE_WEB_DIST` and the single-container compose files
are deleted, not kept alongside. No rollback path is planned or tested. The
release still takes the usual pre-release database backup
(`docs/deployment.md`), because that procedure is cheap and protects the data,
not the old UI.

## Left to the builder

- Exact page layouts, columns, copy, icons (Lucide, as Kore), density.
- Cookie contents (token vs session id), CSRF mechanism, sign-in route location.
- How SSR and client components split per page.
- Maintenance colour value.
- Whether `/monitors/[id]` and the peek panel share one component.
- Test tooling for the new app (Kore uses Vitest and Playwright).
