# Copilot instructions for Flatline

## Goals

- Check spelling and API/documentation consistency against the code.
- Do not post a "Pull Request Overview".
- Stay quiet when there is nothing to say.

## Repository overview

Flatline is a self-hosted uptime monitor and fleet-telemetry system: a fork of
Uptime Kuma with its own Rust backend, a Go host agent, a Go backup agent and a
Next.js web app behind Caddy. The Node/Express backend, the Vue frontend, the
standalone Next.js status app and the Vite dashboard (`apps/dashboard/`) were
**removed**; do not suggest changes to them or look for them.

| Piece                                                 | Language                     | Where              |
| ----------------------------------------------------- | ---------------------------- | ------------------ |
| Backend (API, check engine, storage, agent downloads) | Rust                         | `backend-rs/`      |
| Host agent pushed to each server                      | Go                           | `superboard/`      |
| Backup agent                                          | Go                           | `backup-agent/`    |
| Web app: operator UI, Superboard, status pages        | TypeScript + React (Next.js) | `apps/web/`        |
| Status-page client and types                          | TypeScript                   | `packages/shared/` |
| Reverse proxy routing the backend and the web app     | Caddy                        | `docker/Caddyfile` |

Runtime requirements: `cargo`, `go`, and Node for the web app (its dev server,
build and production server). Data is SQLite, migrated at startup from
`backend-rs/migrations/`.

## What to keep in mind when reviewing

- **There is one level of operator access.** Member accounts (email and
  password) and operator tokens (`flatline_op_` prefix) are both
  full-permission credentials; there are no roles, invites or scopes. Push
  tokens are separate and only affect their own monitor; backup-agent tokens
  are separate again. Anything that describes a read-only or scoped key or
  account is wrong.
- **Five monitor types only:** `http`, `https`, `push`, `ping`, `group`. Other
  upstream types were not ported; unknown payload fields are reported back in
  `ignoredFields` rather than rejected.
- **Notifications are Telegram only.** The other 108 upstream providers were
  removed.
- **The agent is push-only.** `superboard` never listens on a port; the backend
  never connects to a client host. Silence from an agent is the down signal.
- **Documentation lives in `docs/`.** Besides `README.md`, the repository root
  holds only `AGENTS.md` (coding-agent instructions) and `CLAUDE.md` (which
  imports it). If a change alters behaviour, the matching document in
  `docs/` should change in the same commit.
- **Migrations are additive and ordered.** Add a new `NNNN_name.sql`; never edit
  an applied migration. The backend refuses to start against a database with
  migrations it does not know, so a rollback also needs a database restore.

## Build and validation commands

| Task                | Command                                                   |
| ------------------- | --------------------------------------------------------- |
| Backend tests       | `cargo test --manifest-path backend-rs/Cargo.toml`        |
| Formatting          | `npm run fmt:check`                                       |
| Web app tests       | `npm run test:web`                                        |
| Web app types       | `npm run typecheck:web`                                   |
| Web app build       | `npm run build:web`                                       |
| Agent build and vet | `cd superboard && go build ./... && go vet ./...`         |
| Local stack         | `./dev.sh` (backend `:3001`, web app `:3003`, mock fleet) |

## Style

- The repository is formatted by Prettier (`npm run fmt`, verified by
  `npm run fmt:check`). Do not hand-format; run the formatter instead.
  `.prettierignore` covers the lockfile, local state and build output.
- Keep pure presentation logic in `apps/web/lib/` so it can be tested without
  a DOM (Vitest, `apps/web/__tests__/`).
- Rust: small module surfaces, explicit error types, comments that explain
  contracts and reasons. The tree is not uniformly `rustfmt`-formatted.
- Go: `gofmt` clean, one collector per file, collectors degrade to
  "unavailable" instead of failing a sample.
- Avoid emoji in code comments and commit messages.
