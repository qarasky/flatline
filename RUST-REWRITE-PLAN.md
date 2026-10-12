# Rust backend rewrite — plan

Status: **started.** Scope locked with the operator on 2026-10-12. The
existing Node backend and the Go agent stay untouched until cutover; this
document is the contract the Rust rewrite is built against. M0–M2 are
shipped in `backend-rs/`.

## Locked scope (from the operator's answers)

**In:**

- **Monitors:** push and http(s), plus group containers. No other types.
- **Surfaces:** monitor table + detail/history, Superboard (kiosk, group
  scopes, rename, agent warnings), Agents panel (API key management).
- **Checks:** HTTP scheduling with retries, uptime windows, Telegram
  notifications, push-timeout detection.
- **Push protocol:** the exact contract the Go agent uses today
  (`/api/push/:token?telemetry=1`, fast-path heartbeat spacing, 400 =
  metrics dropped but heartbeat recorded).
- **Metrics pipeline:** the full Phase 1–5 port — counter transforms,
  sampledAt backfill, archive gating, hourly rollups, threshold alerts,
  live cache, SSE deltas, `cpuPeak10m`, two-tier history summary.
- **API consumers:** AI/automation via REST v1 + OpenAPI, status badges,
  the agent push endpoint.
- **Auth:** one token signs you in; all tokens are full permission. New
  tokens are SHA-256 at rest; imported API keys stay valid by verifying
  their bcrypt hashes (so existing AI tokens keep working).
- **Data:** new schema + a one-time importer from the old SQLite database.

**Out (per the answers):**

- Users, invites, TOTP, token scopes, roles.
- Maintenance windows, tags.
- Prometheus `/metrics`, the built-in cloudflared integration.
- Keyword/JSON checks and the other 25 monitor types.

## Flagged decisions (veto welcome)

1. **Status pages.** Not selected, but the deployed client pages
   (`/status/clients`, host-mapped domains, password gates) read the
   status-page API, and the SPA still has those routes. Recommendation:
   keep a **minimal read-only status-page API** (config, heartbeats,
   incident history, resolve-host, unlock) and import page configs, so the
   deployed pages survive. Authoring (creating pages, incident CRUD) stays
   out of v1 — pages are frozen until a later pass. Dropping this entirely
   breaks client-facing URLs at cutover.
2. **Dashboard sign-in.** The SPA currently posts username+password. Zero
   frontend change: accept the single token as the password. Better UX:
   a one-field token form — a small frontend follow-up, not part of the
   backend rewrite.
3. **Notification config.** There is no notification UI today either
   (verified); Telegram config arrives via the importer and is edited via
   the API. Confirm that is acceptable, or budget a tiny settings form.

## Parity matrix (what the SPA and agents call)

| Endpoint | Caller | v1 scope |
|---|---|---|
| `POST /api/push/:token` (+`?telemetry=1`) | Go agent | exact contract incl. spacing, 400 semantics |
| `GET /api/v1/health` | SPA, AI | token-authed aggregate |
| `GET/POST/PATCH/DELETE /api/v1/monitors[/:id]` | SPA, AI | push/http/group, pagination, `?q=`, `?active=` |
| `POST /api/v1/monitors/:id/pause` `/resume` | SPA | |
| `GET /api/v1/monitors/:id/heartbeats?limit=` | detail view | newest first + `total` |
| `GET /api/v1/monitors/metrics/latest?ids=` | Superboard | bulk, `cpuPeak10m` included |
| `GET /api/v1/monitors/:id/metrics/summary?hours=` | history dialog | two-tier, ≤240 buckets |
| `GET /api/v1/monitors/:id/metrics?hours=` | AI | raw rows, capped |
| `GET /api/v1/events` | SPA | SSE: ready/heartbeat/metrics/invalidate/unauthorized, keepalives, bounded streams |
| `GET /api/v1/monitor-types` | monitor form | type list + writable fields |
| `GET/POST/DELETE /api/v1/api-keys[/:id]` | Agents panel | no scopes, full permission |
| `GET /api/v1/openapi.json` | AI | updated to the Rust surface |
| `GET /api/badge/:id/status|uptime|ping|avg-response|response` | badges | SVG |
| `GET /api/status-page/...` | status pages (flagged) | read-only + unlock |
| `GET /api/v1/auth/me`, `/setup`, `/login` | TokenGate | `/me` = token check; `/setup` = `setupNeeded:false`; `/login` accepts the token as password (compat) |

Dropped endpoints: `/api/v1/users*`, `/api/v1/invites*`, `/api/v1/auth/invites*`,
`/metrics`, cloudflared routes, maintenance/tags/status-page authoring.

## Architecture

- **axum + tokio + sqlx (SQLite) + serde**, one binary; `rust-embed` serves
  the existing SPA build (no frontend rewrite).
- Single process, WAL mode; the importer runs offline against a copy.
- **New schema** (owned by Rust migrations):
  `monitors`, `heartbeats`, `metrics_raw`, `metrics_hourly`, `tokens`,
  `notifications`, `monitor_notifications`, `status_pages` (+ groups,
  monitors, incidents), `settings`.
- **Uptime** is computed from heartbeats (time-weighted), not the old
  aggregate tables — a deliberate simplification the new schema allows.
- Tokens: `tokens` table with `hash`, `scheme` (`sha256` for new, `bcrypt`
  for imported keys), `name`, `created_at`, `last_used_at`.
- First boot mints an admin token, writes it to `data/initial-token.txt`
  (0600) and logs it once.

## Repo layout

```
backend-rs/
  Cargo.toml
  migrations/           # sqlx migrations, new schema
  src/
    main.rs             # config, boot, graceful shutdown
    config.rs           # env: DATA_DIR, PORT, FLATLINE_WEB_DIST
    db.rs               # pool + migrations
    auth.rs             # token mint/verify (sha256 + bcrypt), middleware
    api/                # v1 router, push, badges, status pages, openapi
    monitors/           # engine, http checker, scheduler, push timeout
    metrics/            # ingest, transforms, rollup, alerts, peak
    notify/             # telegram
    events.rs           # SSE fan-out
    import/             # old-DB importer
  tests/                # integration tests (axum oneshot + live sqlite)
```

## Milestones

- **M0 — skeleton (shipped):** crate, config, sqlx pool + migrations
  (tokens, monitors, heartbeats), token auth (sha256 + bcrypt import),
  `/api/v1/health` with the Node-compatible envelope, first-boot admin
  token file, 7 tests, fmt/clippy clean.
- **M1 — monitors core (shipped):** CRUD with the Node envelope
  (`{ok, count, monitors, pagination}` / `{ok, monitor, ignoredFields}`),
  groups with cycle validation and `deleteChildren`, pause/resume via
  PATCH, `monitor-types`, `/auth/setup|login|me` compat (token accepted as
  the password), SSE `/api/v1/events` with ready/keepalive/revalidation/
  stream caps, invalidate on every mutation. 20 tests.
- **M2 — checks + heartbeats (shipped):** HTTP scheduler (method, timeout,
  redirects, ignoreTls, accepted status ranges, Node-compatible messages),
  retries → PENDING → DOWN, time-weighted uptime 24h/7d/30d computed from
  heartbeats, Telegram alerts with the resend walk and notification links
  (`notificationIDList` on create/patch), the push endpoint with the
  telemetry fast path, push-timeout watching, `GET .../heartbeats`
  (newest first + total), a minimal notifications API (list redacted,
  create/patch/delete), and SSE `heartbeat` patches with uptime. Metrics
  storage and the 400 "metrics dropped" response arrive with M3. 33 tests.
- **M3 — metrics pipeline:** ingest + transforms, archive + sampledAt,
  live cache + SSE metrics, bulk latest, summary two-tier, rollups +
  prune, threshold alerts, `cpuPeak10m`.
- **M4 — completeness:** badges, OpenAPI, API keys, status-page read API
  (if not vetoed), SPA serving.
- **M5 — importer + cutover tooling:** old-DB importer, Docker image,
  compose update, cutover/rollback runbook.
- **M6 — parity verification:** contract tests against both backends on a
  copy of the production DB; golden-path checklist.

## Cutover and rollback

1. Build the Rust image; deploy alongside (different port) on office.
2. Import a copy of the production DB; run contract tests against both.
3. Switch the tunnel port to the Rust backend; keep the Node container and
   the pre-cutover DB untouched.
4. Rollback = point the tunnel back and restart the Node container; no data
   is written by the importer to the old DB.
