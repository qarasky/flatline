# Flatline — Status Pages & Frontend Rework

Spec for two things: making status pages self-configuring from monitor groups,
and replacing the Vue frontend with two focused apps.

Status: **shipped.** Phase 1 (backend) and Phase 2 (both apps) are built;
the old Vue frontend is deleted and the backend serves JSON only.

**Revision (v2 consolidation, 2026-10-12):** the separate Next.js status app
is gone. Status pages are public routes in the dashboard SPA
(`/status/:slug`, and the site root on host-mapped client domains), and the
built SPA is served by the backend process itself — one container, one
origin.
The original "separate app" decision bought process isolation and server
rendering; in practice the app was 511 lines carrying a full Next.js
runtime, every page is `noindex`, and the only no-JS consumer (curl) has the
JSON API. The data path is unchanged: password-gated API reads, page-scoped
unlock cookies, and the same markup and CSS, now scoped under
`.status-page`. Cost accepted: the first paint is a loading state instead of
server-rendered HTML.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Public status surface | Public **routes in the dashboard app** (v2 consolidation; originally a separate Next.js app — revised, see below) |
| Status pages from groups | Opt-in per group; slug pinned on create; live sync; unpublish-not-delete |
| Aggregate "all clients" page | **Private internal view**, not a public status page |
| Indexing | All status pages `noindex, nofollow, no robots` |
| Per-client branding | Logo (exists) + **free-form hex accent** |
| Accent vs status colours | Accent is brand only. Status palette is fixed semantic and never derived from accent |
| Monitor form | Compact + separate advanced page |
| Dashboard | Dense and utilitarian |
| Agents | In scope, with full status-page CRUD and rearrange rights |

### Found while spec'ing

`status_page.search_engine_index` is written (`database.js:713`) but **never read** —
no robots meta is emitted anywhere in the codebase. The field is currently dead, so the
noindex work is genuinely new rather than a wiring fix.

---

## Phase 1 — Backend

No frontend dependency. Each step is shippable and testable alone.

### 1.1 Migration

`db/knex_migrations/2026-10-04-0000-status-page-group-linking.js`

```sql
-- on status_page
ALTER TABLE status_page ADD COLUMN accent_color   VARCHAR(9)  NULL;   -- "#ff4d2e"
ALTER TABLE status_page ADD COLUMN source_group_monitor_id INTEGER NULL; -- the group this page was generated from
ALTER TABLE status_page ADD COLUMN generated       BOOLEAN NOT NULL DEFAULT 0;

CREATE INDEX status_page_source_group ON status_page (source_group_monitor_id);
```

Notes:
- `source_group_monitor_id` has no FK: the monitor may be deleted while the page survives
  (we unpublish rather than delete). Orphaned pages are identifiable and reported.
- `accent_color` validated in application code, not the DB: must match
  `^#[0-9a-fA-F]{6}$` (expand 3-digit shorthand on write).
- Follow the repo rule: knex methods only, no native SQL.

### 1.2 Auto-generated status pages

Trigger: toggling "publish status page" on a `type: "group"` monitor.

| Event | Behaviour |
|---|---|
| Toggle on | Create status page (title = group name, slug from group name, **pinned**), create a `group` row linking page↔monitors, backfill `monitor_group` from the group's children |
| Monitor added to group | Appears on the page automatically (live sync) |
| Monitor removed from group | Removed from `monitor_group` on next sync |
| Group renamed | Page title follows; **slug does not change** |
| Group deleted | Page **unpublished** (`published = 0`), kept with a "no longer monitored" notice. Not deleted. |
| Toggle off | Unpublish, keep the page |

Slug collision: append `-2`, `-3`, … and surface the chosen slug to the caller.

Sync runs on a debounce after monitor/group mutations, not per keystroke.

### 1.3 Private aggregate view

Not a `status_page`. A dashboard view aggregating every group monitor with live status,
rendered in the dense/utilitarian style. No public route, no branding, no robots concern.

### 1.4 REST API — status pages

Today `GET /api/v1/status-pages` is read-only and agents cannot change anything.
Mirror the existing socket surface (`getStatusPage`, `saveStatusPage`, `addStatusPage`,
`deleteStatusPage`, incidents) plus domains and groups.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/status-pages` | read | list (exists, extend with `generated`, `accentColor`, `domains`) |
| `POST` | `/api/v1/status-pages` | write | create |
| `GET` | `/api/v1/status-pages/:id` | read | read one |
| `PATCH` | `/api/v1/status-pages/:id` | write | update config/accent |
| `DELETE` | `/api/v1/status-pages/:id` | publish | delete |
| `POST` | `/api/v1/status-pages/:id/publish` | **publish** | set `published` |
| `GET`/`POST` | `/api/v1/status-pages/:id/domains` | read / publish | CNAME host mappings |
| `DELETE` | `/api/v1/status-pages/:id/domains/:domain` | publish | remove mapping |
| `GET`/`POST` | `/api/v1/status-pages/:id/groups` | read / write | sections within the page |
| `PATCH`/`DELETE` | `/api/v1/status-pages/:id/groups/:groupId` | write | rename / remove section |
| `PUT` | `/api/v1/status-pages/:id/groups/:groupId/monitors` | write | **set** monitor membership (idempotent — this is the "rearrange" verb) |
| `GET`/`POST` | `/api/v1/status-pages/:id/incidents` | read / write | incidents |
| `PATCH`/`DELETE` | `/api/v1/incidents/:id` | write | edit / delete |
| `POST` | `/api/v1/incidents/:id/resolve` | write | resolve |
| `POST` | `/api/v1/status-pages/:id/regenerate` | write | re-sync from source group |

`PUT .../monitors` takes the full desired membership and reconciles. Idempotent and
safe to retry, which matters for agents.

### 1.5 Scope: add `publish`

`read` < `write` < `publish`. `publish` is required only for actions that make something
reachable from the internet: publishing a page, adding a CNAME, deleting a page.

Rationale: an agent should be able to fix a broken page layout without being able to
expose a client's internal status page.

Changes:
- `api-key-socket-handler.js:34` — extend the hardcoded `read`/`write` allowlist
- `apiKeyScopes()` treats `NULL` (legacy keys) as `["read","write","publish"]` so existing
  tokens are not silently downgraded
- Scope resolution is currently a flat `includes()`; needs to become ordered

### 1.6 No indexing

Applied to every status page response, regardless of `search_engine_index`:

- `<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">`
- `X-Robots-Tag: noindex, nofollow, noarchive, noimageindex`
- A root `robots.txt` with `Disallow: /`

Note honestly: robots meta is **advisory**. It stops compliant crawlers, not a determined
one. Real protection is the password field (`status_page.password`, exists) plus
unpredictable slugs. `Disallow:` in robots.txt does **not** prevent crawling of a known URL.

### 1.7 Accent colour handling

- Stored per status page as free-form hex.
- The public status site sets `--brand: <accent>`.
- Status palette is fixed and never derived from accent:
  up green, degraded amber, outage red, maintenance blue.
- Validate contrast of accent against both light and dark surfaces at write time and
  reject values below ~3:1, so a bad pick fails loudly rather than shipping an
  unreadable client page.

---

## Phase 2 — Frontend rewrite

Two apps. The backend is frozen; this phase changes zero backend behaviour.

### 2a. Public status site — Next.js (superseded in v2: now public routes in the dashboard SPA), App Router

Serves both `/status/:slug` and host-based (`status.client-a.kz` → resolve by Host).

Per request: resolve page → theme → accent → render.

- Per-client logo + accent
- Overall status hero (the pattern reworked this session)
- Incident cards, monitor groups with heartbeat bars
- Robots meta per response
- Optional password gate
- Static/ISR where possible; must stay correct for live status, so prefer SSR + short
  cache with live data fetched client-side for heartbeats

### 2b. Private app — dashboard, dense and utilitarian

Not the status-page aesthetic. Tables, keyboard-first, maximum information per row.

- **Dashboard** — dense status table across all groups; counts inline, not as hero cards
- **Monitor form** — compact page (name, type, target, interval) + separate **Advanced**
  page (retries, TLS, auth, conditions, headers)
- **Command palette** — `/` search, `c` create, `g`+key navigation
- **Bulk actions** — select many: pause, resume, tag, move group, delete
- **Maintenance visible inline** — a monitor under maintenance is visibly distinct in
  lists, not buried on a separate page
- **Agent panel** — create scoped token inline, copyable `curl`, link to
  `/api/v1/openapi.json`, plain-English scope explanation
- **Activity view** — with ownership removed, "who changed what" is the only accountability
  signal, so surface it

### 2c. Deliberately dropped from the old UI

- The 4,644-line `EditMonitor.vue` with 173 `monitor.type ===` conditionals, replaced by
  per-type field schemas rendered from spec
- Five equal-weight Quick Stats cards, replaced by a dense table
- Flat monitor list, replaced by collapsible groups + tag chips
- Colour-only status encoding — icon + word + colour everywhere

---

## Sequencing and risks

1. Migration
2. Auto-generated pages + live sync
3. Scopes (`publish`) + status-page REST
4. noindex
5. Public status site
6. Private app

| Risk | Mitigation |
|---|---|
| Frontend rewrite stalls mid-way, leaving nothing usable | Each phase ships standalone; Phase 1 is useful with no UI work |
| Agents auto-publish something sensitive | `publish` scope gates every internet-facing action |
| Accent colour collides with status meaning | Accent never drives status colour; contrast-checked at write |
| Slug churn breaks published client links | Slug pinned at creation, never derived again |
| Host routing silently breaks behind proxy | `trustProxy` documented + verified in deployment notes |
| Scope change locks out existing tokens | `NULL` scopes map to full access incl. `publish` |

## Resolved

| Question | Decision |
|---|---|
| Per-client pages password-protected by default? | **Yes.** `status_page.password` is the real access control; robots meta is advisory |
| Aggregate view | **Saved view**, not a fixed route |
| Anything missing from the dense dashboard spec | No |

### Consequences of password-by-default

- A generated page gets a random password on creation, shown once to the admin.
- Password is hashed at rest; never returned by the API after creation.
- This makes "publish" meaningfully different from "reveal": a page can be live and still
  unreachable without the password, which is the correct default for per-client pages.
- The saved aggregate view stays inside the authenticated dashboard, so it needs no
  password and is never public.