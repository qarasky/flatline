# Admin panel, part 7: the cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Flatline as three containers: Caddy in front, the Rust backend, and the Next.js web app. Delete the old Vite dashboard, then cut production over.

**Architecture:**

- **Caddy is the only published service.** It takes over `FLATLINE_BIND`/`FLATLINE_PORT`, so on office it listens on `127.0.0.1:3001` and the tunnel stays as it is.
- **Routing:**
  - Caddy sends the backend's paths to `flatline:3001`: `/api/*`, `/agent/*`, `/healthz`, `/add-push-server.md`, `/llms.txt` and `/robots.txt`.
  - Everything else goes to `web:3000`.
  - Both proxies use `flush_interval -1` and no body limit.
- **The backend** loses its static fallback (`web::fallback`, `FLATLINE_WEB_DIST`), and its image stops building the dashboard. It still needs outbound internet (checks and Telegram), so it sits on an egress network besides the internal one.
- **The Caddyfile is baked into a small image** (`docker/caddy.dockerfile`). Compose files then work from any directory, and the office's source-tree swap cannot leave a stale bind mount behind.

**Tech Stack:** Caddy 2.11, Node 26 (Next standalone), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-28-admin-panel-rewrite-design.md`, "Deployment" and "Order of work" step 6. Part 7 of 7.

## Global Constraints

- **Stack name and service name stay** (`flatline-rust`, `flatline`). The container `flatline-rust-flatline-1` is what the watcher cron and the docs name.
- **Both compose files are still passed on office.** The backups override targets the `flatline` service.
- **Distinct subnet from Kore** (`172.31.255.0/24`). Flatline's edge network is `${FLATLINE_SUBNET:-172.31.254.0/24}`.
- **Client IP:**
  - `CF-Connecting-IP` is kept only from the host and its trusted range, and stripped from anyone else (sign-in limits use it).
  - `X-Forwarded-Proto` from the host (cloudflared, `https`) is honoured, so session cookies stay `Secure`.
- **Headers:**
  - a CSP with no external hosts on the UI;
  - `X-Robots-Tag: noindex, nofollow` everywhere;
  - status pages keep `noindex, nofollow, noarchive, nosnippet` (Next sets it on `/status/*`).
- **Resource limits on every service:** `mem_limit`, `pids_limit`, json-file log rotation, `stop_grace_period`.

## Review Focus

1. **A backend path Caddy would send to Next.** A test derives the routes from `backend-rs/src/api/mod.rs` and checks each against the Caddyfile's backend matcher. Test: Task 2, `every_backend_route_reaches_the_backend`.
2. **SSE and backup transfers through Caddy.** They must be unbuffered, with no size limit. Browser check: the live stream through the local three-container stack. Check: a large upload through Caddy (Task 2).
3. **The wall TV at cutover.**
   - The old Vite kiosk polls `/index.html` and must see a different entry script, then reload into the new app.
   - The new kiosk must sign itself in with the token the old one left in `localStorage`, instead of showing a QR.
   - Tests: Task 1. Browser check: Task 1.
4. **Session cookies behind the tunnel.** `Secure` is set when cloudflared says `https`, and a LAN client cannot forge it. Check: the local stack with a forged header from a non-host source (Task 2).
5. **Production cutover and rollback.** Pre-release database backup, rollback tags for all three images, the old single-container compose kept as `compose.rust.prev.yaml`. Task 5.

---

### Task 1: The wall TV carries over

- `app/index.html/route.ts`:
  - `GET` answers a tiny HTML document whose module script is `/assets/flatline-next.js`, so the old dashboard's fingerprint differs and it reloads;
  - it carries a `<meta http-equiv="refresh" content="0; url=/">` for a person who opens it;
  - `Cache-Control: no-store`.
  - Test first, with the old dashboard's `entryAssetFromHtml` rule copied into the test.
- `components/superboard/kiosk-sign-in.tsx`: before requesting a QR code, run `keepMigrating` (the sign-in form's legacy-token migration).
  - `migrated` → reload;
  - `none` or `rejected` → the QR flow;
  - "Signing in…" while it runs.
- Browser check: a fresh context with `flatline.token` in `localStorage` opens `/superboard/kiosk`; the board appears with no QR, and the key is gone.
- Commit `feat(web): the old wall TV reloads into the new app and keeps its sign-in`.

### Task 2: Caddy, the web image and compose

- Create:
  - `docker/Caddyfile`;
  - `docker/caddy.dockerfile` (`FROM caddy:2.11-alpine`, `COPY` the Caddyfile);
  - `docker/web.dockerfile` (Next standalone from the repo root; `server.js` at `apps/web/server.js`; `FLATLINE_BUILD_ID` build arg; `API_URL=http://flatline:3001`; runs as `node`; a healthcheck).
- Rewrite `compose.yaml` (public) and `docker/compose.rust.yaml` (office) as three services with networks:
  - `edge`, fixed subnet: caddy;
  - `internal`, `internal: true`: caddy, web, flatline;
  - `egress`: flatline.
  - Office images: `artchsh/flatline-{rust,web,caddy}:office-live`.
- `backend-rs/tests/caddy_routes.rs`: parse every `.route("…"` path in `src/api/mod.rs`, and check each matches a path in the Caddyfile's `@backend` matcher (Caddy `path` semantics: exact, or a `prefix/*`). Test first: RED without the Caddyfile.
- Local check: build the three images natively, then `docker compose -p flatline-local -f compose.yaml up` on a scratch data dir. Verify:
  - `/healthz`, `/`, `/sign-in`, `/api/v1/auth/setup`;
  - the operator sign-in and the live stream through Caddy;
  - a 64 MiB backup chunk upload;
  - a forged `CF-Connecting-IP` and `X-Forwarded-Proto` from the LAN address are dropped and overwritten;
  - the headers (CSP, X-Robots-Tag).
- Commit `feat(docker): Caddy in front of the backend and the web app`.

### Task 3: The backend stops serving the dashboard

- Remove `web::fallback`, `src/api/web.rs`'s SPA serving and `Config::web_dist` / `FLATLINE_WEB_DIST`. The router's fallback answers the JSON 404.
- Remove the dashboard stage from `docker/rust.dockerfile`.
- Update or remove the tests that covered SPA serving. The JSON 404 for an unknown path stays tested.
- Commit `refactor(backend): the web app is served by Next, not the backend`.

### Task 4: Delete the old dashboard, `dev.sh` and docs

- Delete `apps/dashboard/`. Remove the `test:dashboard`, `typecheck:dashboard` and `build:dashboard` scripts.
- `dev.sh`: no Vite dashboard on `:3004`.
- Docs:
  - rewrite `docs/dashboard.md` (the web app);
  - update `architecture.md`, `deployment.md` (topology, three images, release and rollback with three tags), `development.md`, `superboard.md`, `status-pages.md`, `docs/README.md` and `README.md`;
  - the AGENTS.md layout and checks tables;
  - `.github/copilot-instructions.md`.
- Full check suite. Commit `chore: delete the old dashboard`.

### Task 5: Production cutover

- Merge to master and push (the user's one-pass request is the go-ahead).
- On office:
  1. sync the source;
  2. build the three images to `office-new`;
  3. tag the running backend `office-prev-$REL`;
  4. take the SQLite online backup;
  5. keep the old compose file as `compose.rust.prev.yaml`;
  6. install the new `compose.rust.yaml`;
  7. promote and `up -d` with both files, plus `--remove-orphans`.
- Verify:
  - all three containers are healthy;
  - `/healthz`, plus the public `/`, `/status/clients`, `/superboard/kiosk` and `/api/v1/auth/setup`;
  - `/api/v1/monitors` answers 401;
  - agents still push (newest telemetry seconds old);
  - the kiosk build check sees the stub;
  - session cookies are `Secure` through the tunnel.
- Record the release in `docs/deployment.md` and `docs/history.md`, then push.
