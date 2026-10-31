# Admin panel, part 5: Superboard, kiosk, status pages and device sign-in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Superboard (desk and kiosk), the kiosk's QR sign-in, the phone's approve page, and the public status pages, now rendered on the server, into `apps/web`. Also port new-deploy detection and the self-healing error screens, so `apps/web` can replace `apps/dashboard` in part 7.

**Architecture:**

- **Ported as they are.** These screens are not redesigned (spec: "Ported as they are … Inherits Inter and the accent; nothing else changes"). Their components are copied from `apps/dashboard/src/components/`. The old UI primitives they use (`button`, `badge`, `select`, `checkbox`, `input`) are vendored into `components/legacy-ui/`.
- **Old styles, scoped.** The old CSS (theme variables, the Superboard section, the status page section and the form controls) moves to `app/legacy.css` under a `.legacy-theme` scope. The admin theme is untouched. Inside that scope `--primary` and `--ring` are the new accent and maintenance is violet.
- **The Superboard** lives outside the admin layout and keeps its own self-contained data loading, now through the cookie-authenticated live hub.
- **Status pages** are server components that read the page with the shared `fetchStatusPage` client against `API_URL`, forwarding the visitor's page-unlock cookie. A client component then takes over the 30 s refresh. Their route group has no admin code.

**Tech Stack:** as parts 3–4.

**Spec:** `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md`, "Routes that keep their behaviour", "Signing in" (signed-out kiosk shows the QR) and "Live updates" (new-deploy detection must keep working). Part 5 of 7.

## Global Constraints

- **Parts 3–4 constraints hold.** No external loads; there is no Google favicon on cards either: ProviderLogo is already bundled-only.
- **Routes:**
  - `/superboard`, `/superboard/<scope>`, `/superboard/kiosk` and `/superboard/kiosk/<groups>` (`boardRouteFrom` decides);
  - `/status/<slug>`, and `/` on a host the backend maps (`GET /api/status-page/resolve-host`);
  - `/device` (`#<code>` in the fragment).
- **Signed out:**
  - the desk `/superboard` goes to `/sign-in?next=…`;
  - kiosk routes show the QR sign-in in place;
  - `/status/*` is public;
  - `/device` asks the phone to sign in and comes back with the code (the fragment never reaches the server, so the page builds `next` itself).
- **Unattended screens reload themselves:** kiosk and status pages reload after a new deploy and 30 s after an error. Operator routes show a "New version — Reload" prompt and "Try again / Reload page".
- **A status page visitor downloads no operator code:** the `app/status` route group imports nothing from `components/board`, `components/monitors` or the admin layout.
- **Status pages keep their indexing rules:** `noindex, nofollow, noarchive, nosnippet` meta and an `X-Robots-Tag` header (`next.config.ts` `headers()`).

## Review Focus

1. **The wall TV signed out, or with its token revoked.** The kiosk shows the QR, never the sign-in form. Approving on a phone signs it in (token → session cookie) with no keyboard at the TV. Browser check: Task 3.
2. **A status page on a client domain.** `/` with a mapped `Host` renders that page on the server. An unmapped host goes to sign-in, and a backend lookup error shows a retrying notice, not the operator UI. Browser check: Task 4, with a `Host` header.
3. **A password-protected status page.** Locked shows the unlock form (server-rendered), unlocking reloads into the page, and the unlock cookie is forwarded on later server renders. Browser check: Task 4.
4. **A failed refresh on a status page or the kiosk.** The last good page stays, with the "Stale since" banner and backoff (ported `status-snapshot` rules). Tests: ported `status-snapshot` tests.
5. **A new deploy while a kiosk or status page is open.** It reloads by itself; an operator page shows a prompt instead. Test: Task 5, `isNewBuild` on build ids.

---

### Task 1: Legacy theme, vendored primitives and ported tests

- Create:
  - `apps/web/app/legacy.css`: the old `:root` variables re-scoped to `.legacy-theme`, with `--primary` and `--ring` set to `#5b8def` and `--color-maint` violet; plus the old index.css sections for the Superboard, status page and form controls, unchanged.
  - `apps/web/components/legacy-ui/{button,badge,select,checkbox,input}.tsx`, copied.
- Copy `device-auth.ts` and `device-poll.ts` into `apps/web/lib`, with their tests and the `device-routes` and `status-snapshot` tests under `__tests__/ported/`. `status-snapshot.ts` is copied now (it was not in part 3).
- Gate: `npm run test:web && npm run typecheck:web` pass, with the same number of tests as the originals. Commit `feat(web): legacy theme and ported device and status logic`.

### Task 2: The Superboard

- Create `apps/web/app/superboard/[[...path]]/page.tsx` and `layout.tsx` (`.legacy-theme`, no admin provider). The page resolves the route with `boardRouteFrom`; an unknown path is not found.
- Create `apps/web/components/superboard/{superboard,fleet-card,server-menu,website-links}.tsx`, ported. Changes from the old files:
  - imports point at `@/lib/monitors-api`, `@/lib/live-hub` and the ported fleet components;
  - the load-history menu item opens `LoadHistory` in a dialog;
  - a 401 from the stream or a read → desk: `/sign-in?expired=1&next=…`; kiosk: the QR (Task 3).
- Browser check:
  - the desk board shows one card per push monitor with bars and containers;
  - a scope (`/superboard/<group slug>`) narrows it;
  - `/superboard/kiosk` has no chrome and paginates per `perPage`;
  - the card menu mutes and unmutes;
  - `Rename…` persists.
- Commit `feat(web): the Superboard`.

### Task 3: Kiosk QR sign-in and the phone's approve page

- Modify `lib/gate.ts`:
  - signed out, `/superboard/kiosk…`, `/status/…` and `/device` pass;
  - signed out, `/superboard` and `/superboard/<scope>` go to sign-in.
- Test (RED first) in `gate.test.ts`.
- Create `components/superboard/device-sign-in.tsx`, a port. On `approved` it posts `{token}` to `/api/v1/auth/session` (cookie) and reloads; the token is never stored.
- Create `app/device/page.tsx` and `components/device/device-approve.tsx`, ported:
  - signed out (`/auth/me` 401) → `location.assign("/sign-in?next=" + encodeURIComponent("/device#" + code))`;
  - `safeNext` keeps a fragment (test first).
- Browser check: a fresh kiosk context shows the QR; approving its code from a signed-in context makes the kiosk board appear without a keyboard.
- Commit `feat(web): kiosk QR sign-in and the approve page`.

### Task 4: Status pages, rendered on the server

- Create:
  - `app/status/[slug]/page.tsx` + `layout.tsx` (`.legacy-theme`, robots metadata);
  - `components/status/{status-page-view,status-page-app,unlock-form}.tsx`, ported. The app is seeded with the server's snapshot and keeps the old 30 s refresh, deadline and backoff.
- Server read:
  - `fetchStatusPage(API_URL, slug)`, forwarding `fl_status_auth`;
  - 401 `password_required` → render `UnlockForm`;
  - 404 → not found.
- Modify `app/page.tsx` (root). For a signed-out visitor (the gate now lets `/` through without a session), resolve the request `Host` through `resolve-host`:
  - mapped → render the status page for that slug;
  - unmapped → redirect `/sign-in`;
  - lookup error → a "Status unavailable, retrying" notice that reloads in 30 s.
  - Signed-in visitors keep the `/monitors` redirect.
- `next.config.ts`: `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on `/status/:path*`.
- Browser check:
  - `/status/<slug>` HTML contains the page title and group names before any script;
  - a request to `/` with `Host: <mapped domain>` renders that page;
  - a locked page shows the form, and the right password reloads into the page;
  - the bundle for `/status/<slug>` contains no `BoardDataProvider` (grep the route's client chunks).
- Commit `feat(web): status pages rendered on the server`.

### Task 5: New-deploy detection and self-healing error screens

- Create `lib/build-id.ts`:
  - `BUILD_ID`, baked at build time from `next.config.ts` (`env.FLATLINE_BUILD`, set from `FLATLINE_BUILD_ID` or the build time);
  - `isNewBuild(loaded, served)`: true only when both are known and differ.
- Create `app/build/route.ts`, answering `{build}` with `Cache-Control: no-store`. Test first.
- Create `components/update-watcher.tsx`, a port. It polls `/build` every 5 minutes, when the tab becomes visible and on live-stream resync. Mode `reload` (kiosk, status) or `prompt` (operator: a small "New version — Reload" bar in the admin layout).
- Create `error.tsx` for `superboard` and `status` that reloads after 30 s; the admin `error.tsx` keeps Try again / Reload page.
- Docs: `docs/development.md` lines for parts 4–5; `docs/superboard.md` and `docs/status-pages.md` say these now come from the web app (the route behaviour is unchanged).
- Full check suite. Commit `feat(web): new-deploy detection and self-healing error screens`.
