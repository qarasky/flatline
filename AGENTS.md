# Agent instructions for Flatline

Flatline is a self-hosted uptime monitor and fleet-telemetry system: a fork of
Uptime Kuma with its own Rust backend, a Go host agent, a Go backup agent and a
React dashboard, deployed as one origin. The Node/Express backend, the Vue
frontend and the Next.js status app were **removed**; do not look for them.

Start with [docs/README.md](docs/README.md): it routes every task to the right
document. This file holds only what an agent needs before it opens that index.

## Layout

| Path               | What                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `backend-rs/`      | Rust backend (API, check engine, storage, web host), migrations.   |
| `superboard/`      | Go telemetry agent on each host; `superboard/mockagent` for dev.   |
| `backup-agent/`    | Go backup agent (`flatline-backup`), independent of `superboard`.  |
| `apps/dashboard/`  | React/Vite dashboard, Superboard and status pages.                 |
| `apps/web/`        | Next.js admin panel replacing `apps/dashboard/` (in progress).     |
| `packages/shared/` | Types shared by the dashboard and its tests.                       |
| `docker/`          | Dockerfile, office compose file, backups override, nightly backup. |
| `docs/`            | All documentation; `provisioning.md` is served from the binary.    |

## Checks

Run the ones that cover what you touched before calling work done.

| Area         | Command                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| Formatting   | `npm run fmt:check` (fix with `npm run fmt`; never hand-format)                        |
| Backend      | `cargo test --manifest-path backend-rs/Cargo.toml`                                     |
| Dashboard    | `npm run test:dashboard && npm run typecheck:dashboard`                                |
| Web app      | `npm run test:web && npm run typecheck:web`                                            |
| Agent        | `cd superboard && gofmt -l . && go vet ./... && go test ./...`                         |
| Backup agent | `cd backup-agent && go vet ./... && go test -race ./...`                               |
| Local stack  | `./dev.sh` (backend `:3001`, web `:3003`, old dashboard `:3004`, mock fleet), `status` |

Do not run `cargo fmt` across the tree: it is not uniformly `rustfmt`-formatted.

## Rules

- **Docs change with behaviour.** If a change alters what a user, operator or
  agent sees, update the matching file in `docs/` in the same commit.
- **Migrations are additive and ordered.** Add `backend-rs/migrations/NNNN_*.sql`;
  never edit an applied one. The backend refuses a database with migrations it
  does not know, so a rollback needs the matching database backup.
- **Agent changes need a version bump to ship.** Hosts self-update only to a
  newer `version` in `superboard/main.go`. Bump it (and the version examples in
  `docs/agent.md`, `docs/superboard.md`, `docs/deployment.md` and the mock
  agent) whenever agent code changes.
- **The backup agent has its own version line.** `const version` in
  `backup-agent/main.go` (`0.x`) is separate from the telemetry agent's; bump it
  whenever backup-agent code changes, or hosts never self-update to it.
- **New agent config keys** get a default in `superboard/config.go` and a row
  in `docs/agent.md`.
- **API routes** are registered in `backend-rs/src/api/mod.rs` and documented
  in `backend-rs/src/api/openapi.json`, the served contract.
- **One credential type.** `flatline_` tokens are full-permission; push tokens
  only affect their own monitor; backup-agent tokens are separate again. Never
  describe scoped or read-only tokens.
- **The agents are push-only.** Neither agent listens on a port and the backend
  never connects to a client host.
- Commit subjects follow `type(scope): summary` (`feat(agent): ...`,
  `fix(dashboard): ...`, `docs: ...`). No emoji in code or commits.
- **Never push, deploy or restart production without an explicit go-ahead**
  from the user in the current conversation.

## Production

One container on the **office host** (`office`, Tailscale `100.120.148.13`),
public at `https://uptime.mediaboost.kz` through a Cloudflare Tunnel. Full
record: [docs/deployment.md](docs/deployment.md).

- Docker is rootful there; every docker command needs `sudo`.
- **Always pass both compose files** to `up`:
  `sudo docker compose -f compose.rust.yaml -f /home/office/flatline-src/docker/compose.backups.yaml up -d`
  (from `/home/office/flatline`). With the first file alone the container
  loses its backup mount and uploads answer 503.
- Before any recreate that ships migrations, take the SQLite online backup
  described in `docs/deployment.md` (never `cp` a live database).
- The office is in a residential building with **frequent power cuts**. A
  fleet-wide burst of push failures or dropped samples usually means the
  server was down: check `journalctl --list-boots` on office first. Cloudflare
  `530 / error 1033` from agents means the tunnel had no connector.
- **A deploy is a fleet rollout.** The image carries both agents' builds; hosts
  self-update daily to the image's telemetry agent (`/agent/*`) and backup agent
  (`/api/backup/v1/release/*`). Ship agent bumps deliberately.
- **Backups on office:** client backup bundles live on the RAID1 mirror at
  `/mnt/mirror/flatline-backups` (`/app/backups` in the container). Flatline's
  own database is backed up nightly by `flatline-backup.timer` to
  `/mnt/mirror/flatline-nightly`. On office, `/usr/local/sbin/flatline-backup`
  is that nightly script, not the backup agent.
- **Backup agents in use:** meks runs `modernization` and `zhkh` (daily 02:00
  and 02:30 Asia/Almaty, self-update on). Prove a restore before enabling a new
  agent's timer; the scratch-container procedure is in `docs/operations.md`.
- Inspect the production database read-only:
  `sqlite3.connect("file:/home/office/flatline/data-rust/flatline.db?mode=ro", uri=True)`
  via `sudo python3` on office (no `sqlite3` CLI there).

## Reaching hosts

- Client servers are reached through standalone SSH launchers (gitignored
  `client-cli/`, and per-project `server-cli/` folders in sibling
  repositories). Read the launcher's `how-to-use.md` first; credentials live in
  the OS keychain.
- **Never ask for, print or store secrets in chat.** If a launcher reports
  `CREDENTIAL_SETUP_REQUIRED`, ask the user to run it once in a terminal.
- Redact tokens when printing configs (`push_token`, `tokenFile` contents,
  `initial-token.txt`, `provisioning-token.txt`).
