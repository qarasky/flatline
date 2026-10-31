# Admin panel, part 3: Monitors, Attention and ⌘K — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Monitors section (list, filters, sort, views, peek panel, full page, form, bulk actions, row menus, keyboard, mute), the Attention section with its sidebar count, and the `⌘K` command palette, in `apps/web`, at feature parity with the old board.

**Architecture:** The pure logic of the old board (`apps/dashboard/src/lib/`) is copied into `apps/web/lib/` with its tests, unchanged apart from import paths; the old dashboard keeps its own copy until part 7 deletes it. One client `BoardDataProvider` in the admin layout owns the roster, strips, agent warnings, backups and the shared live stream (now authenticated by the session cookie), seeded by a server-side roster fetch so pages render on the server. Monitors, Attention, the sidebar badge and `⌘K` all read that one provider. Components are ports of the old ones onto shadcn primitives; the old files are the reference for behaviour.

**Tech Stack:** Next.js 16.4 App Router, React 19.3, Tailwind 4, shadcn/ui (Radix), `cmdk` (through shadcn `command`), lucide-react, Vitest; Rust (axum, sqlx) for one additive API field.

**Spec:** `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md` ("Look and feel", "Information architecture", "Live updates"). This is part 3 of 7 (the spec's step 2 after the accounts insert). Behaviour of the old board: `docs/dashboard.md` ("The monitor board", "The monitor form").

## Global Constraints

- Everything in part 1's Global Constraints still holds (versions, no external loads, brand and status tokens, radius 6 px, focus ring, `prefers-reduced-motion`, repo rules).
- Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing route code (`apps/web/AGENTS.md`). In Next 16 a page's `params` and `searchParams` are Promises; a client component calling `useSearchParams` needs a `<Suspense>` boundary.
- Status is a dot shape **and** a word, never colour alone. Maintenance is violet (`--status-maint`); the accent is never a status.
- **Ported modules are copied, not rewritten:** same exports, same behaviour, only `./api` imports change. Their tests move with them and keep their assertions.
- No new runtime dependencies except `cmdk` (pulled in by `npx shadcn add command`). No `motion` library: highlights are CSS transitions under `motion-safe:`; layout animation is dropped (writer's call).
- shadcn adds an unrelated npm package `cn` on install: repoint generated imports to `@/lib/utils` and `npm uninstall cn` each time (seen twice in part 2).
- No external loads: the provider picker shows labels only; the Google favicon fallback in `providers.ts` (`faviconUrl`) is not called by anything in this part.
- New-deploy detection (`UpdateWatcher`, `build-version.ts`) moves with the kiosk in part 5; nothing in this part depends on it.
- Pages that are not built yet (Servers, Backups) stay placeholders; links into them point at `/monitors/{id}` for now and are retargeted in part 4.
- Docs: each task that adds something visible adds a line to `docs/development.md`, section "Web app (in progress)". `docs/dashboard.md` is rewritten at the cutover (part 7), when the new app becomes what users see.
- Browser checks run headless Chromium with playwright-core under `/tmp/flatline-shot` against `./dev.sh` (`.dev-data/initial-token.txt` signs in through "Use a token instead"); `./dev.sh` output goes to `/tmp/flatline-dev.log` and is never printed (it contains a token). Restart the stack before a run that signs in many times (sign-in limits).

## Review Focus

1. **The session ends while the page is open** (signed out elsewhere, member removed or reset, token revoked). The live stream's 401 sends the tab to `/sign-in?expired=1&next=<path>` once; no reconnect loop, no empty board pretending to be live. Tests: Task 3 (`a 401 stops the stream and is reported once`), Task 4 browser check.
2. **A monitor deleted by someone else while it is open** in the peek or on its full page. The detail says "This monitor was deleted." with a way back; the peek drops `m` from the URL; no error page. Test: Task 6 browser check (delete through the API while open).
3. **Typing never triggers shortcuts.** `/`, `j`, `k`, `x`, `Enter` do nothing while focus is in a text field (search, rename, form); `Esc` inside a dialog or menu closes only that. Checkboxes are not text fields. Tests: Task 8 `boardKey` cases.
4. **Saving an edit never wipes links it could not load.** If a server's websites or the notification list failed to load, the save sends neither `linkedMonitorIds` nor `notificationIDList`. Tests: Task 7 `buildMonitorPayload` and the existing `linksReady` gate.
5. **Old and bad deep links.** `/?m=12` opens monitor 12; `/?status=down&sort=name` keeps its filters; `/?m=abc`, `/monitors/abc` and `/monitors/99999` end on the list or a 404 page, never an error page. Tests: Task 6 `gate` cases and browser check.

---

### Task 1: The monitor read lists its notifications

**Files:**

- Modify: `backend-rs/src/api/monitors.rs` (`get_one`)
- Modify: `backend-rs/src/api/openapi.json` (Monitor detail response), `docs/api.md`
- Test: `backend-rs/tests/monitors.rs`

**Interfaces:**

- Produces: `GET /api/v1/monitors/{id}` → `monitor.notificationIds: number[]`, ascending, `[]` when none. Only the single-monitor read; the list stays as it is.

- [ ] **Step 1: Write the failing test** `a_monitor_read_lists_its_notification_ids` in `tests/monitors.rs`: create two notifications (`POST /api/v1/notifications` `{name, type:"telegram", config:{}}`), create a monitor with `notificationIDList: [n2, n1]`; assert `GET /monitors/{id}` → `monitor.notificationIds == [n1, n2]` (sorted); `PATCH` with `notificationIDList: {"<n1>": false}` → `[n2]`; a monitor created without the field → `[]`.
- [ ] **Step 2: Run** `cargo test --manifest-path backend-rs/Cargo.toml --test monitors notification_ids` → FAIL (`notificationIds` is null).
- [ ] **Step 3: Implement** in `get_one`: `SELECT notification_id FROM monitor_notifications WHERE monitor_id = ? ORDER BY notification_id`, inserted as `notificationIds`. Document the field in `openapi.json` (the monitor detail schema; `notificationIDList` on create/update already exists) and in `docs/api.md` beside the monitor read.
- [ ] **Step 4: Run** the backend suite: `cargo test --manifest-path backend-rs/Cargo.toml` → all pass; `completeness.rs` still passes.
- [ ] **Step 5: Commit** `feat(backend): the monitor read lists its notifications`.

---

### Task 2: Port the board's pure modules and their tests

**Files:**

- Create: `apps/web/lib/monitor-types.ts`
- Create (copied from `apps/dashboard/src/lib/`): `attention.ts`, `board-format.ts`, `board-model.ts`, `board-url.ts`, `fleet-presentation.ts`, `groups.ts`, `heartbeat-log.ts`, `heartbeat-strip.ts`, `links.ts`, `live-batch.ts`, `live-state.ts`, `monitor-schema.ts`, `motion.ts`, `mute.ts`, `providers.ts`, `serial-refresh.ts`, all under `apps/web/lib/`
- Create (copied from `apps/dashboard/test/`): `apps/web/__tests__/ported/{attention,board-format,board-model,board-url,fleet-presentation,heartbeat-strip,links,live-batch,motion,mute,providers,serial-refresh}.test.mjs`
- Modify: `apps/web/vitest.config.mts` (`include` adds `__tests__/**/*.test.mjs`)

**Interfaces:**

- Produces: `@/lib/monitor-types` exports, copied verbatim from `apps/dashboard/src/lib/api.ts`: `MonitorSummary`, `MonitorMute`, `BackupVerification`, `BackupRunSummary`, `BackupAgentSummary`, `HealthSummary`, `Pagination`, `MetricsPayload` and the types it references, `LatestMetrics`, `CPUPeak`, `HistoryMetric`, `HistoryStats`, `HistoryPoint`, `MetricsHistorySummary`, `MonitorTypeInfo`, `MonitorLinkTarget`, `ResolvedMonitorLink`, `MonitorLinks`, `LiveEvent`. Plus a new `NotificationSummary { id: number; name: string; type: string; active: boolean; isDefault: boolean }`.
- Produces: every copied module under `@/lib/<name>` with its old exports unchanged.

- [ ] **Step 1: Copy the tests first** and convert each mechanically: `import test from "node:test"` → `import { test } from "vitest"`; in `live-batch` `import test, { mock } from "node:test"` → `import { test, vi } from "vitest"`, `mock.timers.enable({ apis: ["setTimeout"] })` → `vi.useFakeTimers()`, `mock.timers.tick(n)` → `vi.advanceTimersByTime(n)`, `mock.timers.reset()` → `vi.useRealTimers()`; `"../src/lib/<name>.ts"` → `"@/lib/<name>"`. Assertions (`node:assert/strict`) stay as they are. Widen the Vitest `include`.
- [ ] **Step 2: Run** `npm run test:web` → FAIL (modules not found).
- [ ] **Step 3: Copy the modules**; in each, `from "./api"` → `from "./monitor-types"`. Write `monitor-types.ts`. Nothing else changes.
- [ ] **Step 4: Run** `npm run test:web && npm run typecheck:web` → PASS. The ported files run exactly as many tests as their originals (`grep -c '^test(' apps/dashboard/test/<name>.test.mjs` per file, compared with Vitest's per-file counts).
- [ ] **Step 5: Commit** `feat(web): port the board's pure modules and tests`.

---

### Task 3: API calls and the shared live stream over the session cookie

**Files:**

- Create: `apps/web/lib/monitors-api.ts`, `apps/web/lib/live-stream.ts`, `apps/web/lib/live-hub.ts`
- Test: `apps/web/__tests__/monitors-api.test.ts`; ported `apps/web/__tests__/ported/{live-updates,live-hub}.test.mjs`

**Interfaces:**

- Consumes: `api<T>(path, {method, body, signal})` and `ApiError(status, code, message, hint?)` from `@/lib/api`; types from Task 2.
- Produces (`@/lib/monitors-api`; each a port of the same-named function in `apps/dashboard/src/lib/api.ts`, built on `api()`, so it works on the server and in the browser; bodies are objects, not JSON strings):
  - `fetchMonitors(params?: {status?, q?, page?, perPage?}, signal?)`, `fetchAllMonitors(signal?): Promise<MonitorSummary[]>`
  - `fetchMonitor(id, signal?): Promise<{ok: true; monitor: MonitorSummary & Record<string, unknown>}>`, `fetchHeartbeats(id, limit = 120, signal?)`
  - `fetchMonitorTypes()`, `createMonitor(payload)`, `updateMonitor(id, payload)`, `deleteMonitor(id, deleteChildren = false)`, `pauseMonitor(id)`, `resumeMonitor(id)`, `muteMonitor(id)`, `unmuteMonitor(id)`, `clearAgentWarnings(id)`
  - `fetchHeartbeatStrips(ids, {hours?, buckets?}, signal?)`, `fetchLatestMetricsBulk(ids, signal?)`, `fetchAllBackupAgents(signal?)`
  - `fetchMonitorLinks(id, signal?)`, `replaceMonitorLinks(id, linkedMonitorIds)`
  - new: `fetchNotifications(): Promise<NotificationSummary[]>` (`GET /api/v1/notifications`, mapped to the summary fields)
- Produces (`@/lib/live-stream`): `watchLive(options)` with the dashboard's option type, except that it fetches same-origin `/api/v1/events` with `credentials: "same-origin"` and no `Authorization` header.
- Produces (`@/lib/live-hub`): `subscribeLive(subscriber): () => void`, `onLiveResync(listener)`, `liveHubState()`, `LiveSubscriber`, as in the dashboard.

- [ ] **Step 1: Write the failing tests.** Port `live-updates.test.mjs` and `live-hub.test.mjs` as in Task 2, drop their `globalThis.window = { localStorage … }` token setup, and import `watchLive` from `@/lib/live-stream`. Add to the live-updates port:
  - `the stream authenticates with the session cookie, never a bearer header`: the stubbed `fetch` records `init`; assert `init.credentials === "same-origin"` and no `Authorization` key in `init.headers`.
  - `a 401 stops the stream and is reported once`: the stub answers 401; assert `error` was called once with `status === 401`, and after 5 s of fake time there was no second `fetch`.

  `monitors-api.test.ts` stubs `fetch` and asserts:
  - `deleteMonitor(5, true)` → `DELETE /api/v1/monitors/5?deleteChildren=true` carrying `X-Flatline-CSRF: 1`;
  - `fetchAllMonitors()` pages with `perPage=200` until `pagination.hasMore` is false and concatenates;
  - `fetchNotifications()` maps to `{id, name, type, active, isDefault}`.

- [ ] **Step 2: Run** `npm run test:web` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules by porting. In `watchLive`, keep the 401/403 stop rule the dashboard already has (no retry on 401/403).
- [ ] **Step 4: Run** `npm run test:web && npm run typecheck:web` → PASS.
- [ ] **Step 5: Commit** `feat(web): monitor API calls and the live stream over the session cookie`.

---

### Task 4: Board data provider and the monitor list

**Files:**

- Create: `apps/web/components/board/board-data.tsx`, `apps/web/lib/order-basis.ts`
- Create (`apps/web/components/monitors/`): `status-dot.tsx`, `heartbeat-strip.tsx`, `monitor-row.tsx`, `group-row.tsx`, `board-tree.tsx`, `board-states.tsx`, `status-summary.tsx`, `monitors-board.tsx`
- Modify: `apps/web/app/(admin)/layout.tsx`, `apps/web/app/(admin)/monitors/page.tsx`
- Test: `apps/web/__tests__/order-basis.test.ts`
- Reference: `apps/dashboard/src/components/board/*` (StatusDot, HeartbeatStrip, MonitorRow, GroupRow, BoardTree, BoardStates, StatusSummary, useBoardData, useIdleCalm), and `Dashboard.tsx` lines 150–270 for the derived board, the collapsed groups and the reorder hold.

**Interfaces:**

- Consumes: Tasks 2–3.
- Produces:
  - `BoardDataProvider({ initialMonitors: MonitorSummary[]; children })` and `useBoardData(): BoardData`. `BoardData` is the dashboard's `BoardData` (`useBoardData.ts:38`) plus `ready: boolean` (first snapshot done).
  - The provider opens the stream through `subscribeLive`. On an `ApiError` 401 it calls `window.location.assign("/sign-in?expired=1&next=" + encodeURIComponent(location.pathname + location.search))`; on 403 `password_change_required` it goes to `PASSWORD_PATH`.
  - `orderBasis(previous: Map<number, MonitorSummary>, monitors: MonitorSummary[], hold: boolean): Map<number, MonitorSummary>`, the pure form of `Dashboard.tsx:166–191`. While `hold` is true, a known monitor keeps its previous `status`/`active` (the sort keys), new monitors are added and deleted ones dropped. When `hold` is false it returns the current monitors.
  - `MonitorsBoard({ initialQuery }: { initialQuery: BoardQuery & { hasParams: boolean } })`, the page's client root. Tasks 5–8 extend it.

- [ ] **Step 1: Write the failing test** `order-basis.test.ts`:
  - `holding keeps the old status for sorting`: previous {1: down}, current {1: up}, hold → basis.get(1).status === 0;
  - `a new monitor joins the held basis`;
  - `a deleted monitor leaves it`;
  - `not holding returns the live roster`.
- [ ] **Step 2: Run** `npm run test:web` → FAIL.
- [ ] **Step 3: Implement `orderBasis`**, then the provider: a port of `useBoardData.ts` seeded with `initialMonitors`. The admin layout fetches `fetchAllMonitors()` on the server; if that fails it passes `[]` and the provider loads on its first snapshot, so other pages never break. The provider wraps the sidebar and the page.
- [ ] **Step 4: Port the list components** onto shadcn and Tailwind tokens:
  - Dense rows with hairline separators.
  - A row is `[dot] name (target, quiet) | status word | 24 h strip | uptime`. Hover or focus swaps the target for ping, last check and type.
  - Group rows show a worst-of dot and up/down counts; collapsed groups are stored under the old `COLLAPSED_KEY` (`Dashboard.tsx:73`).
  - The strip tooltip uses shadcn `Tooltip`.
  - A live status change highlights the row for `HIGHLIGHT_MS` with a `motion-safe:` transition, skipped while calm (`useIdleCalm` port).
  - **Pause** sits in the page header and shows the banner "Live updates paused · N waiting".
  - Holding the reorder uses `orderBasis` with `shouldHoldReorder`.
  - `/monitors` renders `PageHeader` (crumbs `Monitors`; actions Pause and New monitor, the latter wired in Task 7) and `<MonitorsBoard initialQuery={parseBoardQuery(searchString)} />` inside `<Suspense>`.
- [ ] **Step 5: Run** `npm run test:web && npm run typecheck:web && npm run build:web` → PASS.
- [ ] **Step 6: Browser check** (`/tmp/flatline-shot-scripts/web-monitors.mjs`):
  - the HTML from the server already contains the rows (`curl` with the session cookie, or Playwright with JavaScript disabled);
  - the number of monitor rows equals the API's non-group count;
  - a collapsed group stays collapsed after a reload;
  - Pause shows the banner and Resume clears it;
  - with the session ended through `DELETE /api/v1/auth/session` from the page, the tab ends on `/sign-in?expired=1&next=%2Fmonitors`.
- [ ] **Step 7: Commit** `feat(web): the monitor list with live updates`, with a line added to `docs/development.md`.

---

### Task 5: Search, filters, sort, views and density

**Files:**

- Create (`apps/web/components/monitors/`): `board-toolbar.tsx` (search, Filter, Display, Views), `filter-menu.tsx`, `display-menu.tsx`, `views-menu.tsx`
- Create: `apps/web/lib/search-string.ts`
- Modify: `monitors-board.tsx`, `status-summary.tsx`, `app/(admin)/monitors/page.tsx`
- Test: `apps/web/__tests__/search-string.test.ts`
- Reference: `FilterPopover.tsx`, `ViewsMenu.tsx`, `BoardHeader.tsx`, `Dashboard.tsx` 193–216 and 271–285.

**Interfaces:**

- Consumes: `parseBoardQuery`, `serializeBoardQuery`, `loadViews`, `storeViews`, `addView`, `removeView`, `setDefaultView`, `loadDensity`, `VIEWS_KEY`, `DENSITY_KEY` from `@/lib/board-url`; `filterFacets`, `EMPTY_FILTER`, `SORT_KEYS` from `@/lib/board-model`.
- Produces: `toSearchString(params: Record<string, string | string[] | undefined>): string`, which turns a Next `searchParams` object into a `?a=1&b=2` string (or `""`), repeating array values and skipping undefined.

- [ ] **Step 1: Write the failing test** `search-string.test.ts`: `{status: ["down","pending"], q: "kz", m: undefined}` → `"?status=down&status=pending&q=kz"`; `{}` → `""`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** The page reads `searchParams` (a Promise), builds `initialQuery`, and the server render is already filtered.
- [ ] **Step 4: Port the controls** into a toolbar under the page header (Plane's Display/Filter pattern):
  - search (`/` focuses it; Task 8 wires the key);
  - Filter: status chips, type, tags and the "needs attention" preset, with an active-count badge;
  - Display: sort (worst, name, uptime, last change) and comfortable/compact density;
  - Views: save, apply, delete and mark default.
  - The status summary sits in the page header's toolbar row, as the spec moves it there ("All 33 monitors up" / "2 monitors need attention"); its counts toggle the status filter.
  - State changes write the URL with `router.replace(pathname + serializeBoardQuery(query, location.search), { scroll: false })`.
  - When the URL carries no board state, the default view applies after mount (localStorage is client-only).
  - Views and density keep the old storage keys, so a browser's saved views carry over.
- [ ] **Step 5: Run** web tests, typecheck and build → PASS.
- [ ] **Step 6: Browser check:**
  - `/monitors?status=down` shows only down rows;
  - clicking a count toggles its filter in the URL;
  - a saved view set as default applies on a bare `/monitors`;
  - compact density survives a reload;
  - a search matching a group name keeps the whole group.
- [ ] **Step 7: Commit** `feat(web): monitor search, filters, sort and saved views`.

---

### Task 6: Peek panel, full page, mute and old deep links

**Files:**

- Create: `apps/web/components/monitors/monitor-detail.tsx`, `apps/web/components/monitors/peek-panel.tsx`, `apps/web/app/(admin)/monitors/[id]/page.tsx`, `apps/web/app/(admin)/monitors/[id]/not-found.tsx`, `apps/web/lib/monitor-crumbs.ts`
- Modify: `apps/web/lib/gate.ts`, `monitors-board.tsx`
- Test: `apps/web/__tests__/monitor-crumbs.test.ts`, `apps/web/__tests__/gate.test.ts`
- Reference: `MonitorDetail.tsx` (all of it except `BackupAgents`, which goes to Servers in part 4), `DetailPane.tsx`.

**Interfaces:**

- Consumes: `fetchMonitor`, `fetchHeartbeats`, `muteMonitor`, `unmuteMonitor`, `subscribeLive`, `prependBeat`; `Crumb` from `@/components/page-header`.
- Produces:
  - `MonitorDetail({ id, initial?, compact?, onClose?, onEdit })`. `onEdit` is wired in Task 7.
  - `monitorCrumbs(monitors: Pick<MonitorSummary, "id" | "name" | "parent">[], id: number): Crumb[]` → `[{label:"Monitors", href:"/monitors"}, …ancestor groups {label, href:"/monitors/<gid>"}, {label: name}]`. It stops at a parent cycle and leaves out a missing parent.
  - `gate()` gains the legacy root redirect for a signed-in `/` (tests below).

- [ ] **Step 1: Write the failing tests.**
  - `monitor-crumbs.test.ts`:
    - a monitor two groups deep gives four crumbs with the group hrefs;
    - a parent cycle (1→2→1) terminates;
    - an unknown id gives just `[Monitors]`.
  - `gate.test.ts` additions, signed in:
    - `/` + `?m=12` → `/monitors/12`;
    - `?m=abc` → `/monitors`;
    - `?status=down&sort=name&m=` → `/monitors?status=down&sort=name`;
    - `?foo=1` → `/monitors` (only `BOARD_KEYS` minus `m` carry over).
    - Signed out, `/?m=12` → `/sign-in?next=%2F%3Fm%3D12`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `monitorCrumbs` and the gate change.
- [ ] **Step 4: Port `MonitorDetail`:**
  - **Header:** name, status word, Mute/Unmute ("Muted 5m ago" / "Muted with <server>"), Edit, and in the peek an "Open full page" link.
  - **Body:** the 24 h, 7 d and 30 d uptimes and the interval; recent checks (BeatBar); the ping trend; the certificate; the events table.
  - Live beats are appended through `prependBeat`, as before.
  - A 404 on any read shows "This monitor was deleted." with a link back to `/monitors`; in the peek it also removes `m` from the URL.
- [ ] **Step 5: The peek panel** opens on `?m=ID`, from a row click or Enter:
  - At `(min-width: 1280px)` it is a 480 px column beside the list; below that it is a right-side `Sheet`.
  - The open row keeps an accent edge, and `Esc` closes the panel.
- [ ] **Step 6: The full page `/monitors/[id]`:**
  - A non-numeric id or an API 404 calls `notFound()`; `not-found.tsx` says "No monitor with that id" and links to `/monitors`.
  - Crumbs come from `monitorCrumbs`.
  - It renders `<MonitorDetail id initial={monitor} />`.
- [ ] **Step 7: Run** web tests, typecheck and build → PASS.
- [ ] **Step 8: Browser check:**
  - clicking a row opens the peek with the list still in place, and the URL has `m`;
  - at 1024 px the peek is a sheet;
  - `Esc` closes it;
  - "Open full page" lands on `/monitors/ID` with group crumbs;
  - muting a down mock-fleet monitor shows "Muted…", and Unmute clears it;
  - `/?m=ID` lands on `/monitors/ID`;
  - `/monitors/abc` and `/monitors/99999` show the not-found page;
  - with the peek open, deleting that monitor through the API shows "This monitor was deleted." and the URL drops `m`.
- [ ] **Step 9: Commit** `feat(web): monitor peek panel and full page`.

---

### Task 7: The monitor form, with notifications

**Files:**

- Create: `apps/web/lib/monitor-payload.ts`, `apps/web/components/monitors/monitor-form.tsx`, `apps/web/components/monitors/link-picker.tsx`, `apps/web/components/monitors/new-monitor-dialog.tsx`
- Modify: `monitor-detail.tsx` (Edit swaps the detail for the form in place, in the peek and on the full page), `app/(admin)/monitors/page.tsx` (New monitor), `monitors-board.tsx` (`?new=1[&parent=ID]` opens the dialog; closing removes the params)
- Test: `apps/web/__tests__/monitor-payload.test.ts`
- Reference: `MonitorForm.tsx`, `WebsiteLinks.tsx` (`LinkPicker`), `monitor-schema.ts`.
- Add shadcn: `select`, `textarea`, `switch`, `popover` (as needed).

**Interfaces:**

- Consumes: `fetchMonitorTypes`, `createMonitor`, `updateMonitor`, `fetchMonitorLinks`, `replaceMonitorLinks`, `fetchNotifications`, `groupOptions`, `buildLinkCandidates`, `schemaFor`, `fieldsFor`, `defaultsFor`, `ALERT_THRESHOLD_FIELDS`, `PROVIDERS`; `monitor.notificationIds` (Task 1).
- Produces: `buildMonitorPayload(type: string, values: Record<string, unknown>, notifications?: number[]): Record<string, unknown>`. It is the pure form of `MonitorForm.tsx` `submit` (the payload part):
  - `type` is always sent;
  - keys whose value is `undefined` or `""` are dropped;
  - every `ALERT_THRESHOLD_FIELDS` key is always present, `null` when empty;
  - `provider` is trimmed and lowercased, or `null`;
  - `notificationIDList` is set to the array **only when** `notifications` is given.

- [ ] **Step 1: Write the failing test** `monitor-payload.test.ts`:
  - `{name:"api", url:"", metricCpuThreshold: 90}` for `http` → no `url` key, `metricCpuThreshold: 90`, `metricRamThreshold: null`, `metricDiskThreshold: null`, `provider: null`, `type: "http"`;
  - `provider: "  Hetzner "` → `"hetzner"`;
  - with `notifications: [3, 1]` → `notificationIDList: [3, 1]`;
  - without it → no `notificationIDList` key (Review Focus 4);
  - `parent: null` is kept (leaving a group must send null).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4: Port the form** onto shadcn fields:
  - the type picker offers the server's types;
  - the type is locked on edit;
  - basics are shown, plus "Show advanced";
  - the Group picker uses `groupOptions`, excluding the monitor's own subtree;
  - Provider is a select of `PROVIDERS` labels plus "Other…" free text;
  - Websites (push and manual types) use `LinkPicker` and keep the old `linksReady` gate;
  - `ignoredFields` is shown after a save;
  - the interval advice for agent hosts stays.
- [ ] **Step 5: Add the notifications picker.** It is a checkbox list from `fetchNotifications()`, initially ticked from `monitor.notificationIds` on edit, or from each notification's `isDefault` on create. If the list fails to load, the picker says so and the save passes no `notifications`.
- [ ] **Step 6: Wire the form into the pages.**
  - **Create** happens in a modal (`NewMonitorDialog`), from the header button or `?new=1`; `&parent=ID` preselects the group.
  - **Edit** happens in the peek and on the full page.
  - After a save, call `reload()` from `useBoardData`.
- [ ] **Step 7: Run** web tests, typecheck and build → PASS.
- [ ] **Step 8: Browser check:**
  - create an HTTP monitor with one notification ticked; it appears in the list;
  - Edit shows the notification still ticked (round trip through Task 1);
  - unticking and saving leaves `notificationIds` at `[]` (checked through the API);
  - the type select is disabled on edit;
  - `/monitors?new=1&parent=<group>` opens the dialog with that group chosen.
- [ ] **Step 9: Commit** `feat(web): the monitor form, with notifications`.

---

### Task 8: Selection, bulk actions, row menus and the keyboard

**Files:**

- Create: `apps/web/lib/board-keys.ts`, `apps/web/lib/row-menu.ts`
- Create (`apps/web/components/monitors/`): `selection-bar.tsx`, `row-menu.tsx`, `rename-dialog.tsx`, `move-dialog.tsx`, `delete-group-dialog.tsx`, `delete-monitors-dialog.tsx`
- Modify: `monitors-board.tsx`, `monitor-row.tsx`, `group-row.tsx`
- Test: `apps/web/__tests__/board-keys.test.ts`, `apps/web/__tests__/row-menu.test.ts`
- Reference: `Dashboard.tsx` 287–315 (bulk), 316–418 (keyboard), 419–524 (menus, delete group); `ServerMenu.tsx` (`MoveDialog`, `DeleteGroupDialog`, `RenameDialog`); `SelectionBar.tsx`.
- Add shadcn: `context-menu`.

**Interfaces:**

- Produces:
  - `type BoardKeyAction = "focusSearch" | "down" | "up" | "open" | "select" | "escape"`.
  - `boardKey(e: { key: string; target: "text" | "checkbox" | "other"; overlayOpen: boolean; modifier: boolean }): BoardKeyAction | null`.
  - `moveCursor(rows: number[], current: number | null, delta: 1 | -1): number | null`, clamped at the ends; from `null` it gives the first row (down) or the last row (up).
  - `escapeStep(s: { peekOpen: boolean; selected: number; filterActive: boolean }): "closePeek" | "clearSelection" | "clearFilters" | null`.
  - `type RowMenuId = "open" | "edit" | "rename" | "move" | "mute" | "unmute" | "pause" | "resume" | "newSubgroup" | "delete"`.
  - `monitorMenuItems(m: MonitorSummary): RowMenuId[]` and `groupMenuItems(g: MonitorSummary, worst: StatusKey): RowMenuId[]`, where `worst` is the group node's worst-of key from `buildBoard`.

- [ ] **Step 1: Write the failing tests.**
  - `board-keys.test.ts`:
    - `j` in a text field → null;
    - `j` on a checkbox → "down";
    - `/` → "focusSearch" unless typing;
    - `Escape` with an overlay open → null;
    - `j` with a modifier → null;
    - `x` → "select";
    - `Enter` in a text field → null;
    - `moveCursor([4,7,9], null, 1)` → 4;
    - `moveCursor([4,7,9], 9, 1)` → 9;
    - `moveCursor([], null, 1)` → null;
    - `escapeStep` order: peek, then selection, then filters, then null.
  - `row-menu.test.ts`:
    - an unmuted down monitor → contains "mute" and not "unmute";
    - a covered monitor (`mutedBy: [5]`) → "unmute";
    - `active: false` → "resume" and not "pause";
    - an up monitor → no "mute";
    - a group with `worst: "down"` and no `mutedBy` → `["open","edit","newSubgroup","rename","move","mute","delete"]`;
    - the same group with `worst: "up"` → the same list without "mute";
    - a group with `mutedBy: [g]` → "unmute" in place of "mute";
    - every list starts with "open".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both modules.
- [ ] **Step 4: Selection and bulk actions.**
  - Each row has a checkbox, shown on hover, on focus, or whenever something is selected.
  - A floating `SelectionBar` offers Pause, Resume, Delete (through `delete-monitors-dialog`, listing the names) and Clear. Each action calls the API per id, then `reload()`.
  - Partial failures are reported by name.
- [ ] **Step 5: Row menus and dialogs.**
  - The `⋯` button opens a `DropdownMenu`, and right-click opens a `ContextMenu`, both from `row-menu.ts`.
  - The dialogs are ports. Delete group offers both old modes: children move up, or the whole subtree is deleted with its history.
  - New subgroup → `?new=1&parent=ID&type=group`.
- [ ] **Step 6: Keyboard.** One `keydown` listener on the document runs `boardKey`, `moveCursor` and `escapeStep`; the focused row scrolls into view. `target` is "text" for inputs other than checkbox and radio, for `textarea`, `select` and `contenteditable`. `overlayOpen` is true while a Radix dialog or menu is open (`document.querySelector('[role="dialog"],[role="menu"]')`).
- [ ] **Step 7: Run** web tests, typecheck and build → PASS.
- [ ] **Step 8: Browser check:**
  - `j j Enter` opens the second row's peek;
  - `x` shows "1 selected";
  - typing `j` in search moves nothing;
  - `Esc` closes the peek, then clears the selection, then the filters;
  - right-click on a group shows "New subgroup…";
  - deleting a group with "move children up" keeps its children, now under the group's parent.
- [ ] **Step 9: Commit** `feat(web): bulk actions, row menus and keyboard on Monitors`.

---

### Task 9: Attention and its sidebar count

**Files:**

- Create: `apps/web/components/attention/attention-list.tsx`, `apps/web/lib/attention-href.ts`
- Modify: `apps/web/app/(admin)/attention/page.tsx`, `apps/web/components/app-sidebar.tsx`
- Test: `apps/web/__tests__/attention-href.test.ts`
- Reference: `AttentionSection.tsx`, `Dashboard.tsx` (where `deriveAttention` is called).

**Interfaces:**

- Consumes: `deriveAttention`, `unmutedCount` from `@/lib/attention`; `useBoardData()`.
- Produces: `attentionHref(item: AttentionItem): string` → `/monitors?m=<monitorId>`, or `/backups` when `monitorId` is null.

- [ ] **Step 1: Failing test:** a down item with `monitorId: 7` → `/monitors?m=7`; a backup item with `monitorId: null` → `/backups`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4: The page.**
  - `/attention` lists the items in a dense list (Plane's inbox): a kind icon, the name, what is wrong, and for how long. Each row links with `attentionHref`.
  - Muted items come after the rest, with a dark red mark.
  - The header reads "N need attention · M muted".
  - Empty state: "Nothing needs attention."
- [ ] **Step 5: The sidebar** shows `unmutedCount` as a badge on Attention. The badge is hidden at 0 and still visible when the sidebar is collapsed to icons (a dot).
- [ ] **Step 6: Run** web tests, typecheck and build → PASS.
- [ ] **Step 7: Browser check:**
  - the badge equals the page's unmuted count;
  - muting an item's monitor moves it below the rest and lowers the badge;
  - a row opens the peek on Monitors.
- [ ] **Step 8: Commit** `feat(web): the Attention section and its count`.

---

### Task 10: The ⌘K command palette

**Files:**

- Create: `apps/web/lib/commands.ts`, `apps/web/components/command-palette.tsx`
- Modify: `apps/web/app/(admin)/layout.tsx` (mount it), `apps/web/components/app-sidebar.tsx` (a "Search ⌘K" button at the top)
- Test: `apps/web/__tests__/commands.test.ts`
- Add shadcn: `command` (it brings `cmdk`).

**Interfaces:**

- Consumes: `NAV_SECTIONS`, `useBoardData().monitors`, `Me`.
- Produces:
  - `interface Command { id: string; label: string; href: string; keywords: string[] }` and `interface CommandGroup { heading: "Sections" | "Monitors" | "Servers" | "Actions"; commands: Command[] }`.
  - `buildCommands(monitors: MonitorSummary[], me: Me): CommandGroup[]`, in the order Sections, Monitors, Servers, Actions:
    - push monitors go under **Servers**, everything else (groups included) under **Monitors**, both with href `/monitors/<id>`;
    - keywords hold the url, the hostname and the group path;
    - Actions are New monitor (`/monitors?new=1`), Open Superboard (`/superboard`), Change password (accounts only, `PASSWORD_PATH`) and Sign out (id `sign-out`, href `""`, handled by the component).

- [ ] **Step 1: Failing test** `commands.test.ts`:
  - a push monitor is under Servers and not under Monitors;
  - a group is under Monitors;
  - Sections come first and list every `NAV_SECTIONS` entry;
  - a token principal gets no "Change password";
  - a monitor's url is in its keywords.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4: The palette.**
  - `⌘K` / `Ctrl+K` toggles a `CommandDialog` from anywhere in the admin area, including inside text fields. It does not open over another open dialog.
  - Enter navigates with `router.push(href)`. Sign out calls `DELETE /api/v1/auth/session`, then goes to `/sign-in`.
  - The sidebar button shows the shortcut, and the palette closes on navigation.
- [ ] **Step 5: Run the full check** from the repository root:
  - `cargo test --manifest-path backend-rs/Cargo.toml && npm run test:web && npm run typecheck:web && npm run build:web && npm run test:dashboard && npm run typecheck:dashboard && npm run fmt:check` → all pass.
- [ ] **Step 6: Browser check:**
  - `Ctrl+K`, typing a monitor's name and Enter lands on `/monitors/<id>`;
  - "New monitor" opens the create dialog;
  - `Ctrl+K` inside the search box opens the palette;
  - the section list matches the sidebar.
- [ ] **Step 7: Commit** `feat(web): command palette`, with the `docs/development.md` line.
