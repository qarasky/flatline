# Flatline — Fork Roadmap

Personal fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma) (MIT).
Upstream stays untouched; no PRs are sent back.

## Current implementation — October 2026

The sections below retain early investigation and migration notes; old stack
descriptions and unchecked rebrand lists are historical, not the current UI.
The active stack is an API-only Node backend, React/Vite operator dashboard,
Next.js status site, and Go host agent. See [README.md](README.md) for current
setup instructions and fictional-data screenshots.

Delivered since the initial frontend cutover: bearer-authenticated SSE,
1Hz telemetry, 30-second archival, clickable server history with p90/p95/p99,
rolling 10-minute total-CPU peaks, compact looping container tiles, the shared
Flatline favicon, and single-origin production routing
([docker/OFFICE-DEPLOYMENT.md](docker/OFFICE-DEPLOYMENT.md)).

Later work (agent 1.3 era): CPU utilization is derived **server-side** from raw
cumulative counters the agent pushes (long-window means in history, short-window
live readings, agent-side percent retained only as a compat fallback); agents
report read-only pending-update counts rendered as green/yellow/red/dark-red on
cards; boards are group-scoped by URL (`/superboard/kiosk/work`); servers can be
renamed on the board via a right-click menu.

Still planned: private aggregate saved views, and the ranked backlog in
[IMPROVEMENT-ROADMAP.md](IMPROVEMENT-ROADMAP.md) (agent self-telemetry,
disk-backed send buffer, threshold alerts, multi-tier retention, network
counters, per-container stats, SMART health). Dependency hardening is a
separate outstanding pass; feature completion does
not imply those inherited advisories have been resolved.

Upstream's contributor-policy and CI files were removed — this fork is solo-developed and
merges straight to `main`:

- `AGENTS.md`, `CLAUDE.md` (contributor policy / AI-slop warnings)
- `.github/workflows/` (all 21: PR checks, issue bots, CodeQL, Docker, releases)
- `.github/actions/setup-atlascloud`, `.github/config/` (only used by deleted workflows)
- `.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`, `REVIEW_GUIDELINES.md`
- `.github/dependabot.yml` (only tracked GitHub Actions — now pointless)
- `.github/FUNDING.yml` (upstream's donation links)
- AI-slop warning in `.github/copilot-instructions.md`

`.github/` now holds just `copilot-instructions.md` and `opencode-models.json`.
**The underlying advice still stands:** understand every line before you ship it.
Run `npm run lint` and `npm test` locally — nothing enforces it for you anymore.

---

## Project goals

| Goal | Status |
|---|---|
| Rebrand to **Flatline** | **Done** |
| Frontend cutover (Next.js status site + React dashboard, API-only backend) | **Done** |
| Multi-user, no roles (admin-issued single-use invite links) | **Done** |
| Telegram-only notifications | **Done** (needs manual test) |
| Agentic REST API with tokens | **Done** (verified end to end) |

### Rebrand scope

- [ ] Display name `Uptime Kuma` → `Flatline` (`src/util.ts:44`, `index.html`)
- [ ] npm package name in `package.json`
- [ ] Docker image refs (`package.json` scripts, `docker/*.dockerfile`, `compose.yaml`)
- [ ] Icons / logo (`public/`: `icon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192x192.png`, `icon-512x512.png`, `icon.png`, `manifest.json`)
- [ ] Console output (`server/server.js` "Welcome to...", `process.title`)
- [ ] Docs (`README.md`)
- [ ] Hardcoded upstream URLs (105 files reference the `uptime-kuma` slug)

Current counts: **144 files** contain "Uptime Kuma", **105 files** contain `uptime-kuma`.

Cyberpunk palette targets `src/assets/vars.scss` (`$primary: #5cdd8b` today).

**License:** keep MIT `LICENSE` + Louis Lam's copyright. Add own copyright alongside.
Never ship upstream's name/logo in the fork (the name is a separate trademark from the code).

### Frontend cutover — DONE

The Vue frontend is deleted and the backend is API-only:

- Backend `:3001` serves JSON only: `/` is an API index, unknown routes are
  JSON 404s, `robots.txt` is a static `Disallow: /`. No `dist/` build is
  required to boot. The old `/status/:slug` HTML routes are gone; the JSON
  data routes (`/api/status-page/*`, heartbeat, incidents, badges, RSS,
  resolve-host, unlock) stay because the Next.js app reads them.
- `apps/status-site` (Next.js, `:3002`) owns public status pages;
  `apps/dashboard` (Vite + React, `:3003`) owns monitors, Superboard and
  user administration.
- Auth is one model: `server/routers/auth-router.js` exposes password login
  (mints a 30-day full-scope token), setup status, invite check/redeem and
  account admin over REST. The dashboard signs in with username + password
  (TOTP when enrolled), redeems invites at `/invite/:token`, and manages
  users in the Users panel. No session cookie, no Socket.IO in the browser
  flow.
- Deleted: `src/` except `src/util.ts` (the server imports it in ~70 places),
  root `index.html` + `vite.config.mjs`, `test/e2e` + playwright config,
  `public/` icons except `icon.svg` (README logo), 49 Vue/e2e devDeps,
  `express-static-gzip`, the translation test (no `src/lang` to check
  against), and the `docker-latest-warning` snippet (injected into legacy
  HTML images).
- `dev.sh` points the dashboard at the LAN IP (the bare hostname does not
  resolve on macOS) and no longer prints a token hint — sign in instead.

Follow-ups, both done: Socket.IO handlers + better-auth session routes were
removed server-side (commit "Remove Socket.IO and session routes"), and all
three apps have production Docker packaging (`compose.yaml`: backend,
dashboard behind nginx, status site on `next start`).

---

## Current stack (reference)

Vue 3 Options API · Vite 8 · Bootstrap 5 + SCSS · vue-router 4 · vue-i18n (81 locales) ·
Socket.IO · Express · redbean-node (ORM) · better-auth · 30k LOC backend / 35k LOC frontend

Notable: 182 `.vue` components, ~110 notification providers (backend + frontend each),
API is basic-auth + API-key only, Socket.IO drives nearly all mutations.

---

## Feature 1 — Multi-user (no roles)

### Findings

Multi-user **partially exists already**:

- `user` table with `username`, `password`, `role` (`db/knex_init_db.js:54`)
- better-auth with `admin()` plugin + `role` field (`server/better-auth.ts:7,88`)
- 47 `user_id` references across the server — data is already scoped per user
- Socket rooms are per-user (`io.to(monitor.user_id)`)

### Gaps

1. **`disableSignUp: true`** (`server/better-auth.ts:74`) — no second user can register.
2. No user-management UI. `Setup.vue` only creates the very first user.
3. **Role is effectively unused** — only ever set to `"admin"`, never checked.
   So "no roles" is already ~true; the work is enabling registration.
4. `/api/setup` needs an equivalent for adding users post-setup.

### Invite model — DONE

**Admin-issued single-use magic link, no email.** Any logged-in user mints a link,
sends it to the other person over any channel they like (Slack, Signal, carrier
pigeon), and the recipient sets their own username + password. Link dies on use.

Deliberately not self-signup: this is a monitoring tool whose whole job is sending
outbound alerts. Open registration plus free-text Telegram targets is an open relay.

Design notes:

- Token is a high-entropy random string, **hashed at rest** (never store the plaintext),
  so a DB leak can't be replayed into account creation.
- Single use enforced **atomically** — consume-and-create in one transaction, so two
  simultaneous redemptions of the same link can't both succeed.
- Add an **expiry** (default 24h) and let the admin revoke outstanding links.
- Invitation is for *account creation only* — the user sets their own password, so
  there is no reset-email flow to build and no email infrastructure at all.
- `disableSignUp: true` stays **on**. Redemption uses an explicit
  `auth().api.createUser()` server-side call (same path `/api/setup` already uses),
  so public signup remains impossible.

### better-auth capability check (done — verdict: build custom)

Inspected `better-auth@1.6.11` directly. Results:

| Plugin / API | Verdict |
|---|---|
| `admin()` (already enabled) | **No invite support.** Surface is only `createUser`, `listUsers`, `setRole`, `banUser`, `removeUser`, `revokeUserSession`, `impersonateUser`. No `inviteUser`. |
| `magic-link` | **Wrong fit.** Email-keyed (needs an email address), creates the user *and* auto-logs them in via `createSession` + `setSessionCookie` — the invitee never sets a password, so the account ends up passwordless. Default expiry is only 5 min, and tokens default to `storeToken: "plain"`. |
| `one-time-token` | **Wrong direction.** Requires an existing session (`sessionMiddleware`) and mints a token *from* a logged-in user to bootstrap another device. That is "I'm logged in, give me a CLI token" — not "admin invites a stranger". |
| `organization` | Has invites, but requires an org and pulls in a large schema. Overkill for flat same-permission users. |

Conclusion: no built-in fit. Build the `user_invite` table, but **reuse `admin().api.createUser()`**
as the account-creation primitive — it is already enabled, already accepts a `password`, and
`/api/setup` uses it today, so username/2FA/email handling stays consistent with first-user setup.

Bonus: better-auth already solved one hard problem for free — magic-link token consumption is
atomic (`consumeVerificationValue`), and it supports `storeToken: "hashed"`. Worth copying that
shape (hash at rest, atomic consume) into our own implementation.

### Shared instance — DONE

Multi-user is for **sharing panel access**, not for dividing ownership. Every logged-in
user sees and edits the same monitors, notifications, maintenance windows, proxies,
containers and tags. This reverts the per-user model inherited from upstream.

Kept per-user (deliberately):

- `user_invite` — each invite lists only under the admin who minted it
- `api_key` — a token belongs to the user who created it, and is the audit trail
- `better_auth_user` — obviously

`monitor.user_id` (and the equivalents) are still **written** on create, purely to record
who added something. They are never used to filter. No migration needed, so an existing
upstream database migrates as-is.

### Why the socket rooms had to change too

Upstream joins each socket to a per-user room and emits every update with
`io.to(socket.userID)`. Dropping the SQL filters alone would have left user B with a
correct-looking dashboard that never updated. So:

- new `server/shared-room.js` exports `SHARED_ROOM = "flatline:shared"`
- `afterLogin` joins **both** rooms (per-user for tokens/invites, shared for everything else)
- ~25 emit sites moved from `io.to(socket.userID)` / `io.to(monitor.user_id)` to
  `io.to(SHARED_ROOM)`: monitorList, heartbeat, avgPing, uptime, certInfo, domainInfo,
  notificationList, maintenanceList, proxyList, dockerHostList, remoteBrowserList,
  monitorTypeList, heartbeatList, importantHeartbeatList, statusPageList, cloudflared
- unauthenticated sockets never join `SHARED_ROOM`, so the login and status pages cannot
  receive dashboard data

### Query and signature changes

- `monitor-service`: `loadOwnedMonitor(userID, id)` → `loadMonitor(id)`;
  `updateMonitor`/`deleteMonitor`/`startMonitor`/`restartMonitor`/`pauseMonitor`/
  `updateMonitorNotification` all lost their `userID` parameter. `createMonitor` keeps it,
  because it records the creator.
- `Monitor.deleteMonitor` / `deleteMonitorRecursively`: dropped the `user_id` predicate.
- `Monitor.sendStats` / `sendCertInfo` / `sendDomainInfo`: dropped `userID`, broadcast to
  the shared room.
- `getMonitorJSONList(userID, monitorID)` keeps its arity but ignores the first argument,
  so existing call sites are untouched.
- `sendMaintenanceListByUserID` is now an alias of `sendMaintenanceList`.
- `clearStatisticsForUser()` is now instance-wide, matching `clearAllStatistics()`.
- REST v1: `loadMonitor`, the monitors list, maintenance, tags, notifications and the
  health summary are no longer filtered; tokens remain per-user.
- Removed `server/socket-handlers/ownership.js` and its call sites wholesale.

### Verified against a simulated upstream migration

Seeded a database the way an existing install looks: one admin owning three monitors, then a
**new** user created afterwards. Against a running server:

- original admin sees 3 monitors
- **the newly invited user also sees all 3** — the migration requirement
- the invited user edits the original admin's monitor → `ok: true`
- the original admin receives that edit as a **live** push (proves the shared room)
- the invited user reads the original admin's chart data → `ok: true`

14 new tests in `test/backend-test/test-shared-instance.ts`, including a source-level guard
that fails if anyone re-adds a `userID` parameter to the service functions. The old
per-user isolation tests were deleted along with the behaviour they asserted.

`lint:js` 0 errors, `vite build` clean, and the invite / api-v1 / monitor-service suites
(14 + 17 + 11) still pass.

### Still to do

Nothing outstanding. Closed in the final pass:

- `test-domain.js` no longer posts to a `webhook` notification. It now points at Telegram via
  `telegramServerUrl` against a local mock Bot API
  (`test/backend-test/notification-providers/mock-telegram.js`), so the "sends a notification"
  test really does assert on an outbound message again. All 18 pass.
- `redeemUserInvite` is rate limited to 20/min (`inviteRateLimiter`). It is unauthenticated and
  the token is the only credential, so this caps brute-force and flooding.
- Account removal: new `server/socket-handlers/user-socket-handler.js` with `getUserList`,
  `deleteUser` and `setUserBanned`, plus an accounts table in Settings → Users.
  Deleting an account also clears its sessions, account rows, 2FA rows, verification records,
  better-auth API keys and any invite links it minted. Shared data (monitors, notifications,
  maintenance) is untouched.
  Guarded: cannot remove or ban yourself, and the last remaining account is protected so the
  instance can never be locked out (signup is invite-only).
  Both mutations are done in SQL rather than through `auth().api.banUser/removeUser`, because
  those endpoints re-check a better-auth session that a socket handler does not have.
- Removed `CONTRIBUTING.md` (no contribution process).

---

## Feature: invite links — DONE
      (unique), `created_by` (string FK to `better_auth_user.id`), `expires`,
      `used_at`, `used_by`, `note`.
- [x] Model `server/model/user_invite.js`: create / findByToken / consume /
      revoke / listForUser / pruneExpired, plus `getStatus()`.
- [x] Socket handler `user-invite-socket-handler.js`: `createUserInvite`,
      `getUserInviteList`, `revokeUserInvite` (all `checkLogin`), plus
      `checkUserInvite`, `redeemUserInvite` and `getUserInviteEnabled`
      (unauthenticated — the recipient is not logged in yet).
- [x] Frontend: `/invite/:token` page (`src/pages/Invite.vue`) verifies the link
      before rendering the form, and Settings → Users (`src/components/settings/Users.vue`)
      mints/revokes and shows the one-time link via the existing CopyableInput.
- [x] New-user creation reuses `auth().api.createUser()`, the same path
      `/api/setup` uses, so username/email/2FA handling is identical.
- [x] Hourly `pruneExpired()` for long-expired rows (unref'd, `timer.unref()`).

Design decisions made during implementation:

- **Token is SHA-256 hashed at rest.** The plaintext exists only in the
  `createUserInvite` response, so a leaked DB or backup cannot be replayed into
  account creation. SHA-256 (not bcrypt) because the token is 32 random bytes —
  nothing to brute force, and the digest must be reproducible to find the row.
- **Single use is enforced atomically in SQL**, via
  `UPDATE ... WHERE id = ? AND used_at IS NULL AND expires > ?`. Two simultaneous
  redemptions cannot both succeed.
- **Consume happens *after* account creation**, and a loser deletes the account
  it just made rather than leaving an orphan user behind.
- **Validation runs before consuming.** A duplicate username or a too-short
  password returns an error and the link is still usable — verified: a link that
  failed on a taken username was then successfully redeemed by someone else.
- **Revoke deletes the row** rather than flagging it, so the token stops working
  immediately.
- No roles, so `created_by` is simply the caller and any user can mint invites.

### Two redbean-node traps hit while implementing

- `R.find` / `R.findOne` hydrate the registered model class; **`R.getAll` returns
  plain objects**. Using `getAll` in `listForUser` gave
  `invite.toJSON is not a function` at runtime even though the unit tests passed.
  Caught only by driving a real server.
- The model file **must be named `user_invite.js`**, not `user-invite.js`.
  `R.autoloadModels` maps by filename, so a hyphenated name is never registered
  and every bean comes back unhydrated.

### Verified

14 unit tests in `test/backend-test/test-user-invite.ts`, plus a live
Socket.IO session against a running server:

- mint → check → redeem creates a working account, and that account can log in
  and mint its own invite (chaining works)
- second redemption of the same link rejected
- weak password and duplicate username rejected **without burning the link**
- bogus / revoked links rejected; `expiryHours` bounds enforced (1–720)
- invited user has full access, consistent with "no roles"

### Not done

- [ ] No way to see *which* user redeemed an invite (only `used_by` is stored,
      not surfaced in the UI).
- [ ] No rate limiting on `redeemUserInvite`. Token entropy makes guessing
      infeasible, but the endpoint is unauthenticated; a limiter would be cheap.
- [ ] Per-user isolation audit (the 47 `user_id` call sites) still outstanding.

---

## Feature 2 — Telegram-only notifications

### Findings

- **110** provider files in `server/notification-providers/`
- **~110** matching components in `src/components/notifications/`
- Registry: `server/notification.js` — ~110 `require()`s (lines 3–~115) plus a
  `new X()` list (lines 128–~230) inside `Notification.init()`
- Frontend registry: `src/components/notifications/index.js` (227 lines of imports/exports)
- Telegram already exists and works — **no new functionality needed**

### Risks

- **Existing rows.** Anyone with a non-Telegram notification in the DB will hit a
  missing-provider path. Needs an explicit decision, not silent breakage.
- Dependency cleanup is a separate pass — several deps exist only for specific
  providers (e.g. `@grpc/grpc-js`, `gamedig`, `kafkajs`, `oracledb`, `ssh2-sftp-client`).
  Do **not** touch these in the same change; verify each is unused first.
- i18n: ~110 providers have translated strings across 81 locale files. Don't mass-delete
  locale keys — leave them, they're inert.

### Plan — DONE

- [x] Deleted 108 non-Telegram server providers + 108 frontend components.
- [x] `server/notification.js`: single `Telegram` require, `list = [new Telegram()]`.
      Removed the Apprise-only `checkApprise()` and its now-unused `commandExists` import.
- [x] `src/components/notifications/index.js`: `{ telegram: Telegram }`.
- [x] `NotificationDialog.vue`: 9 category `<optgroup>`s collapsed to a flat `<option>`
      list; `notificationNameList` is now `{ telegram: "Telegram" }`.
      Removed `notificationFullNameList` (was only a category flattener) and repointed
      `getUniqueDefaultName()` at `notificationNameList`.
- [x] Removed `test-indigo.js` (tested a deleted provider). Kept
      `test-notification-provider.js` (tests the base class, still used by Telegram)
      and `test-ntlm.js` — **axios-ntlm is core monitor infrastructure**
      (`server/model/monitor.js` uses `httpNtlm`), not notification-only.
- [x] Orphaned DB rows: `Notification.send()` now throws a message naming the offending
      type and listing available providers, instead of a bare "not supported".
      Upstream already try/catches per-notification, so a stale row logs an error and
      never breaks the send loop for other notifications.
- [x] Removed `checkApprise` socket handler and the Apprise frontend keys.

**Webpush was removed too** — it is a notification provider like the rest, so keeping it
would have contradicted "Telegram only". That cascaded into:
- `public/serviceWorker.js` deleted, and its registration removed from `src/main.js`
- `getWebpushVapidPublicKey` socket handler + the `web-push` require removed from `server/server.js`
- npm deps `web-push` and `form-data` dropped from `package.json` (verified zero remaining refs)

Left alone deliberately: the ~81 `src/lang/*.json` files still carry `apprise*` and the
9 `notification*` category strings. They are inert, and hand-editing 81 locale files to
remove dead keys is a large diff for zero runtime benefit.

Dependency pruning beyond `web-push`/`form-data` is **not** done — `nodemailer`,
`gamedig`, `kafkajs`, `oracledb`, `ssh2-sftp-client`, `@grpc/grpc-js` etc. are still
referenced by monitor types and DB drivers. Verify each separately before touching.

### Manual verification still required

- [ ] `npm ci && npm run build` (needs Node >= 26.2.0 per `engines`)
- [ ] Create a Telegram notification in the UI and send a test
- [ ] Trigger a real down/up alert end to end
- [ ] If upgrading an existing DB that had other providers, confirm the stale-row error
      message appears and the rest still works

---

## Feature 3 — Agentic REST API with tokens

### Findings

Existing API surface is **almost entirely read-only badges**:

- `server/routers/api-router.js` (655 lines): `/api/entry-page`, `/api/push/:pushToken`,
  and ~7 badge endpoints (status / uptime / ping / avg-response / cert-exp / response)
- Auth: `apiAuth` middleware (`server/auth.js`) — HTTP Basic. API key as the password,
  else username+password. Rate-limited to ~60 req/min.
- API keys already exist: `api_key` table + `better_auth_apikey`, hashed keys formatted
  `uk<id>_<nanoid40>`, created via `addAPIKey` socket event (`api-key-socket-handler.js`)
- **Almost all mutations are Socket.IO only** — no REST equivalent for create/edit/delete

### Definition of "agentic"

For an LLM agent to drive this, it needs full CRUD over HTTP with a real token, not
socket-emit gymnastics. Suggested surface:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/monitors` | list (filterable) |
| `POST` | `/api/v1/monitors` | create |
| `GET` | `/api/v1/monitors/:id` | read, incl. status + uptime |
| `PATCH` | `/api/v1/monitors/:id` | update |
| `DELETE` | `/api/v1/monitors/:id` | delete |
| `GET` | `/api/v1/monitors/:id/heartbeats` | time series |
| `GET``POST` | `/api/v1/incidents` | list / create |
| `GET` | `/api/v1/status-pages` | list |
| `GET` | `/api/v1/maintenance` | list |
| `GET` | `/api/v1/tags` | list |

### Plan — DONE

- [x] `server/routers/api-v1-router.js`, mounted in `server.js` after `api-router`
      and before the SPA catch-all.
- [x] Token auth in `server/auth.js` as `tokenAuth(scope)`:
      `Authorization: Bearer <token>` primary, HTTP Basic (token as password) also
      accepted. Attaches `req.apiUser` / `req.apiKeyID` / `req.apiScopes`.
- [x] `resolveAPIKey()` replaces the old boolean `verifyAPIKey()` internals and is
      reused by the existing basic-auth path, so both schemes share one validator.
      Hardened: requires the `uk` prefix, requires a numeric key id, rejects an
      empty secret.
- [x] Scopes via migration `2026-10-03-0000-api-key-scopes.js` (nullable `scopes`
      column). `NULL` = full access, so pre-existing keys keep working.
      `apiKeyScopes()` maps NULL → `[read, write]`.
- [x] `addAPIKey` socket handler validates requested scopes and rejects unknown
      ones rather than silently granting full access. `APIKey.toPublicJSON()` now
      reports scopes.
- [x] Endpoints: monitors CRUD, `GET /monitors/:id/heartbeats`,
      `POST /monitors/:id/heartbeat` (agent-reported check result, no push token
      needed), `GET /monitor-types`, incidents (list/create), status-pages,
      maintenance, tags, notifications, `GET /health` aggregate.
- [x] Discovery: `GET /api/v1` index and `GET /api/v1/openapi.json` so an agent can
      self-document without a human.
- [x] Rate limiting reuses `apiRateLimiter` (60/min), returning 429.
- [x] Safety: monitor writes go through a `MONITOR_WRITABLE_FIELDS` allowlist, so
      `user_id` and unknown keys are ignored and reported in `ignoredFields`;
      `monitor.validate()` is reused so the API cannot store what the UI rejects;
      every monitor query is scoped by `user_id`.

### Schema findings (corrected during implementation)

- `status_page` and `tag` have **no `user_id` column** — they are global in
  upstream, not per-user. Incidents therefore have no per-user scoping either;
  incidents are listed across all pages, matching what the UI can see.
- `tag` is joined via `monitor_tag`, so `/tags` returns only tags this user's
  monitors actually use.
- `monitor.user_id` became a **string** FK to `better_auth_user.id`
  (migration `2026-05-28-0010-better-auth-foreign-key`), not an integer to `user`.
- `http` / `https` are handled inside `monitor.js` and are **not** in
  `monitorTypeList`, so they are advertised separately by `/monitor-types`.
- `retry_interval` defaults to 0 in the schema but `validate()` rejects anything
  below 1, so creation applies the same `retryInterval = interval` fixup the UI does.

### Verified end to end against a running server

17 auth unit tests pass; manually exercised against a real instance on port 3210:

- 401 with no token / bad token, 403 for a read-only token on write
- create → list → patch → heartbeat(up, ping 123) → health → delete, all green
- monitor id 999 → 404, non-numeric id → 400
- `user_id` and a bogus field ignored and reported in `ignoredFields`
- `/notifications` redacts `telegramBotToken`
- all six read-only collections return `ok: true`

### Not done

- [ ] Token creation still requires the Socket.IO UI; there is no REST endpoint
      for minting or revoking tokens.
- [ ] Maintenance, tags, status-pages and notifications are still unpaginated
      (they are small in practice; add it if any grow large).

---

## Follow-up: shared service, OpenAPI file, pagination — DONE

### 1. Shared monitor logic (`server/monitor-service.js`)

`add`, `editMonitor`, `deleteMonitor`, `pauseMonitor`, `resumeMonitor` in
`server/server.js` were ~250 lines of inline `bean.x = monitor.x` assignments,
duplicated against REST v1. All of it now lives in `server/monitor-service.js`:

- `createMonitor` / `updateMonitor` / `deleteMonitor`
- `startMonitor` / `restartMonitor` / `pauseMonitor` / `loadOwnedMonitor`
- `normaliseMonitorPayload` / `applyIntervalDefaults` — the camelCase→snake_case
  column map, JSON-serialised fields, port/proxyId coercion, frontend-only key
  stripping, and the interval repair the Vue form performs on submit

The old local helpers in `server.js` are thin `@deprecated` re-exports. Net
effect: `server.js` shrank by ~330 lines and the two transports cannot diverge.

Two upstream bugs surfaced while extracting this and are now fixed:

- **`getAllChildrenIDs` recursed forever on a parent cycle** and crashed the
  process with a heap OOM. Rewritten as an iterative walk with a `visited` set.
  Reproduced live before the fix: `PATCH /monitors/1 {"parent":1}` killed the
  server. Now returns `400 Invalid Monitor Group`.
- **`accepted_statuscodes` type check was dropped** during the move; restored.

Also: REST `PATCH` with an invalid group topology returned `500`; it is now `400`.

### 2. OpenAPI served from a file

`server/routers/openapi.json` (13 paths, with schemas, security scheme, and
pagination/error components) is loaded with `require()` and served at
`/api/v1/openapi.json`. Served unauthenticated on purpose: it holds no secrets
and an agent should be able to read it before minting a token.

### 3. Pagination

`?page=` (1-based) and `?perPage=` (default 50, hard cap 200) on `/monitors` and
`/incidents`, returning `{ page, perPage, total, totalPages, hasMore }`. Also
added `?active=`, `?q=` (substring on name/url) to `/monitors` and
`?statusPageId=`, `?active=` to `/incidents`. `/monitors/:id/heartbeats` keeps
plain `?limit` (max 1000) since it is inherently a recent-N query, but now
reports the true `total`.

### Verified

16 new unit tests in `test/backend-test/test-monitor-service.ts`; 17 existing
auth tests still pass. Against a live server: pagination pages 1/2 correct,
`perPage=9999` capped to 200, `page=0` → 400, `?q=M2` filters, partial PATCH
preserves untouched fields, `user_id` rejected, `type` change refused, group
→ non-group conversion unlinks but keeps children, self-parent → 400 without
crashing, group delete unlinks children. `lint:js` 0 errors, `vite build` OK.

**Bug found and fixed by this testing:** `Monitor.getAllChildrenIDs` was
infinite-recursive on a parent cycle. Two group monitors pointing at each other
crashed the whole server. Now iterative with cycle detection.

---

## Suggested order

1. **Telegram-only** — self-contained, lowest risk, validates the fork workflow.
2. **REST API + tokens** — highest value for the agentic use case, biggest surface.
3. **Multi-user** — needs a product decision (invite model) and an isolation audit.
4. **Rebrand** — mechanical, do it once the feature churn settles.
5. **Frontend rework** — only if actually needed.
