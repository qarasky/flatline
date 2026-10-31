# Development

## Prerequisites

| Tool       | Needed for                                                                              |
| ---------- | --------------------------------------------------------------------------------------- |
| `cargo`    | The Rust backend.                                                                       |
| `go`       | The agent and the mock fleet.                                                           |
| Node + npm | The Vite dev server and the dashboard build. The backend and the agent do not use Node. |
| `docker`   | Only if you want to build or run the container image.                                   |

## The local stack

```bash
./dev.sh          # start (or restart) everything
./dev.sh status   # backend and dashboard health
./dev.sh logs     # tail every log
./dev.sh stop     # stop everything
```

`dev.sh` builds and starts four things, detached, logging to `.dev-logs/`:

| Process          | Port | Notes                                                                                            |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------ |
| Backend          | 3001 | Binds `0.0.0.0`, runs migrations, writes the operator token on first boot.                       |
| Web app (Next)   | 3003 | The new admin panel. Rewrites `/api` and `/agent` to the backend, so the browser is same-origin. |
| Dashboard (Vite) | 3004 | The old dashboard, until the rewrite replaces it. Proxies `/api` and `/agent` the same way.      |
| Mock fleet       | —    | `superboard/mockagent`: creates a demo fleet through the public API and pushes telemetry.        |

It also builds the agent binary into `.dev-data/agent/` so the download endpoints
work locally. The first run prints the operator token (also in
`.dev-data/initial-token.txt`).

The mock fleet is the reason the board is never empty during development: it
creates hosts across every card state, a few demo websites linked to the servers
that host them, and leaves agent warnings on two hosts so the "Clear agent
warnings" action and the website picker have something to show.

Local state (`.dev-data/`, `.dev-logs/`) is disposable and Git-ignored. Delete it
to get a cold start — that is also the cheapest way to exercise migrations from
scratch, including the operator-token bootstrap.

### Running the pieces by hand

```bash
# backend
cargo run --manifest-path backend-rs/Cargo.toml
# or a release build, serving the built web app
npm --prefix apps/dashboard run build
DATA_DIR=./data FLATLINE_WEB_DIST=apps/dashboard/dist \
  cargo run --release --manifest-path backend-rs/Cargo.toml

# dashboard (expects a backend on :3001)
cd apps/dashboard && FLATLINE_DEV_BACKEND=http://127.0.0.1:3001 npm run dev

# agent, one collection to stdout
cd superboard && go run . check --server http://127.0.0.1:3001 --token <push token>
```

## Tests and builds

| What              | Command                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Formatting        | `npm run fmt` (write), `npm run fmt:check` (verify). Prettier 3 covers TS/TSX, JS/MJS, CSS, JSON, Markdown and YAML. |
| Backend tests     | `cargo test --manifest-path backend-rs/Cargo.toml` (unit tests plus integration tests in `backend-rs/tests/`).       |
| Dashboard tests   | `npm run test:dashboard` (pure presentation modules, `node --test` over `apps/dashboard/test/*.mjs`).                |
| Dashboard types   | `npm run typecheck:dashboard`                                                                                        |
| Dashboard build   | `npm run build:dashboard`                                                                                            |
| Web app tests     | `npm run test:web` (Vitest over `apps/web/__tests__/`).                                                              |
| Web app types     | `npm run typecheck:web`                                                                                              |
| Web app build     | `npm run build:web` (Next.js standalone output).                                                                     |
| Agent build + vet | `cd superboard && go build ./... && go vet ./...`                                                                    |
| Agent tests       | `cd superboard && go test ./...`                                                                                     |
| Backup agent      | `cd backup-agent && go test ./... && go vet ./...` (add `-race`)                                                     |
| Restore fixture   | `FLATLINE_BACKUP_INTEGRATION=1 go -C backup-agent test ./integration -v` (Docker + postgres:16)                      |
| Image             | `docker build --platform linux/amd64 -f docker/rust.dockerfile -t artchsh/flatline-rust:dev .`                       |

Run the formatter check, the backend tests, the dashboard tests, the typecheck
and the dashboard build before calling a change done; that is the set releases
have been verified with.

## Repository layout

| Path                             | What                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `backend-rs/src/api/`            | HTTP surface: routers, handlers, `openapi.json`.                              |
| `backend-rs/src/monitors/`       | Check engine.                                                                 |
| `backend-rs/src/metrics/`        | Ingest, live cache, archival, rollups, alerts, history.                       |
| `backend-rs/migrations/`         | Ordered SQL migrations.                                                       |
| `backend-rs/tests/`              | Integration tests against a real in-memory SQLite.                            |
| `superboard/`                    | The Go agent (`mockagent/` is the dev fleet).                                 |
| `backup-agent/`                  | The separate backup agent and its offline/restore tests.                      |
| `apps/dashboard/src/components/` | UI components; `lib/` holds the pure presentation logic that the tests cover. |
| `apps/web/`                      | The Next.js admin panel that replaces `apps/dashboard/` (in progress).        |
| `packages/shared/`               | Types shared with the dashboard.                                              |
| `docs/`                          | These documents.                                                              |

### Web app (in progress)

`apps/web/` is the Next.js rewrite of the operator UI
([design](superpowers/specs/2026-10-28-admin-panel-rewrite-design.md)). It
uses the App Router with server rendering, Tailwind CSS 4 and shadcn
components (`components/ui/`, themed in `app/globals.css`). Signed-in pages
forward the `fl_session` session cookie from the server to the backend at
`API_URL` (default `http://127.0.0.1:3001`); in the browser they call the same
origin, which `next.config.ts` rewrites to the backend in development. Until the
rewrite is finished the old dashboard keeps running beside it.

People sign in with an email and password; "Use a token instead" signs in with
an operator token. On a fresh database no account exists yet, so the sign-in
page offers "Create the first account", which asks for an operator token (the
dev stack prints where its token is) besides the new account's details. An
account with a starting password is held on `/account/password` until it
chooses its own. Accounts are added, reset and removed on **Members**
(`/members`); removing someone can also revoke the tokens they made.

**Monitors** (`/monitors`) lists the group tree with live status, 24 h strips
and uptime, rendered on the server and kept live by one shared stream per tab
(`components/board/board-data.tsx`, under the admin layout). The board's pure
logic is a copy of the old dashboard's `src/lib/` modules, with their tests in
`apps/web/__tests__/ported/`. Opening a monitor shows it beside the list (a sheet below
1280 px) with `?m=ID` in the URL; `/monitors/<id>` is its own page. Old
dashboard links (`/?m=ID`, `/?status=down`) redirect there. **New monitor** opens the form
in a dialog (also `?new=1`, with `&parent=ID` or `&newType=group`); Edit opens it
in place. The form sets which notifications a monitor alerts through. Rows have a `⋯` and
right-click menu, a checkbox for bulk Pause, Resume and Delete, and the old
board's keys (`/`, `j`/`k`, `Enter`, `x`, `Esc`; `apps/web/lib/board-keys.ts`). **Attention**
(`/attention`) lists what needs a look, muted items last; its count sits on
the sidebar. `⌘K` / `Ctrl+K` (or Search in the sidebar) jumps to any section,
monitor or server, or runs New monitor, Superboard, Change password or Sign out. **Servers**
(`/servers`) lists every push monitor with live CPU, RAM and fullest-disk use and
how fresh the numbers are. `/servers/<id>` adds the agent's report (with Clear warnings),
load history, containers, linked websites, thresholds and the server's backups. **Backups**
(`/backups`) lists the backup agents; an agent's page edits its settings, lists
runs with downloads and recorded checks, and rotates or revokes its token
(shown once). Servers open from ⌘K and from Attention's silence and agent-warning
rows; backup problems open their agent. **Notifications** (`/notifications`)
lists the Telegram configs with the monitors using each; editing one leaves
the bot-token field empty, and an empty field keeps the stored token.
**Tokens** (`/tokens`) lists operator tokens (device sign-ins from the kiosk's
QR included) with who made each and when it was last used; a new token is
shown once, and disabling or deleting the one this browser signed in with
signs it out.

The **Superboard** (`/superboard`, `/superboard/<scope>`, `/superboard/kiosk…`),
the phone's approve page (`/device`) and public **status pages**
(`/status/<slug>`, and `/` on a mapped client domain) are ported as they were,
in the old look (`app/legacy.css`, scoped to `.legacy-theme`) with the new
accent. Status pages render on the server and load no admin code; a signed-out
kiosk shows its QR sign-in. Open tabs notice a deploy through `GET /build`
(the build id): the kiosk and status pages reload, admin pages offer Reload.
For local status pages, add rows to `status_pages` (there is no API to create
one).

## Conventions

- **TypeScript/React**: formatted by Prettier (4-space indent, double quotes,
  `[ a, b ]` collapsed to `[a, b]`). Run `npm run fmt` before committing and
  `npm run fmt:check` to verify. Effects and callbacks are named, and every
  non-obvious decision is explained by a comment that says _why_. Pure
  formatting and presentation logic belongs in `src/lib/` so it can be unit
  tested without a DOM.
- **Rust**: modules keep their public surface small; functions that talk to the
  database return the API error type rather than panicking; comments explain the
  contract, not the syntax. The tree is not uniformly `rustfmt`-formatted, so
  don't run `cargo fmt` across it.
- **Go**: `gofmt` clean, one collector per file, best-effort collectors return
  "unavailable" rather than failing a sample.
- **Markdown, JSON, YAML and CSS** are Prettier-formatted too; `.prettierignore`
  lists what is left alone (lockfile, local state, build output).

## Changing things

- **A migration**: add `backend-rs/migrations/NNNN_name.sql`, additive where
  possible (`ALTER TABLE … ADD COLUMN` with a default). It is applied
  automatically at startup and recorded in `_sqlx_migrations`; the backend
  refuses to start against a database that contains migrations it does not know,
  which is what makes a rollback need the matching database.
- **An API route**: register it in `backend-rs/src/api/mod.rs` and document it in
  `backend-rs/src/api/openapi.json` — that document is served at
  `/api/v1/openapi.json` and is the API's contract.
- **The provisioning runbook**: edit `docs/provisioning.md`. It is compiled into
  the binary with `include_str!` and copied to `/docs/provisioning.md` in the
  image — if either path changes, both the Rust path and the Dockerfile `COPY`
  must change together.
- **A new agent config key**: add it to `superboard/config.go` with a default,
  then document it in [agent](agent.md).
- **A card change**: the pure logic lives in
  `apps/dashboard/src/lib/fleet-presentation.ts` with tests in
  `apps/dashboard/test/`; keep the visual rules there rather than in the
  component.
- **Anything user-visible**: update the relevant document in `docs/` in the same
  change. The deployment record for shipped work is
  [history](history.md) and [deployment](deployment.md).

## Releasing

Commits land on `master`; there is no release branch. A release is: run the
checks above, commit, push, then deploy following
[deployment](deployment.md) — including the database backup that a rollback would
need.
