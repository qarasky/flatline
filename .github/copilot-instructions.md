# Copilot instructions for Flatline

## Goals

- Check spelling and API/documentation consistency against the code.
- Do not post a "Pull Request Overview".
- Stay quiet when there is nothing to say.

## Repository overview

Flatline is a self-hosted uptime monitor and fleet-telemetry system: a fork of
Uptime Kuma with its own Rust backend, a Go host agent and a React dashboard.
The Node/Express backend, the Vue frontend and the standalone Next.js status app
were **removed**; do not suggest changes to them or look for them.

| Piece                                              | Language                  | Where              |
| -------------------------------------------------- | ------------------------- | ------------------ |
| Backend (API, check engine, storage, web app host) | Rust                      | `backend-rs/`      |
| Host agent pushed to each server                   | Go                        | `superboard/`      |
| Dashboard, Superboard, status pages                | TypeScript + React (Vite) | `apps/dashboard/`  |
| Shared types                                       | TypeScript                | `packages/shared/` |

Runtime requirements: `cargo`, `go`, and Node only for the Vite dev server and
the dashboard build. Data is SQLite, migrated at startup from
`backend-rs/migrations/`.

## What to keep in mind when reviewing

- **There is one credential type.** Tokens are full-permission bearer
  credentials (`flatline_` prefix); there are no users, accounts, invites or
  scopes. Push tokens are separate and only affect their own monitor. Anything
  that describes a read-only or scoped key is wrong.
- **Five monitor types only:** `http`, `https`, `push`, `ping`, `group`. Other
  upstream types were not ported; unknown payload fields are reported back in
  `ignoredFields` rather than rejected.
- **Notifications are Telegram only.** The other 108 upstream providers were
  removed.
- **The agent is push-only.** `superboard` never listens on a port; the backend
  never connects to a client host. Silence from an agent is the down signal.
- **Documentation lives in `docs/`.** `README.md` is the only Markdown file at
  the repository root. If a change alters behaviour, the matching document in
  `docs/` should change in the same commit.
- **Migrations are additive and ordered.** Add a new `NNNN_name.sql`; never edit
  an applied migration. The backend refuses to start against a database with
  migrations it does not know, so a rollback also needs a database restore.

## Build and validation commands

| Task                | Command                                                     |
| ------------------- | ----------------------------------------------------------- |
| Backend tests       | `cargo test --manifest-path backend-rs/Cargo.toml`          |
| Dashboard tests     | `npm run test:dashboard`                                    |
| Dashboard types     | `npm run typecheck:dashboard`                               |
| Dashboard build     | `npm run build:dashboard`                                   |
| Agent build and vet | `cd superboard && go build ./... && go vet ./...`           |
| Local stack         | `./dev.sh` (backend `:3001`, dashboard `:3003`, mock fleet) |

## Style

- The repository is formatted by Prettier (`npm run fmt`, verified by
  `npm run fmt:check`). Do not hand-format; run the formatter instead.
  `.prettierignore` covers the lockfile, local state and build output.
- Keep pure presentation logic in `apps/dashboard/src/lib/` so it can be tested
  without a DOM.
- Rust: small module surfaces, explicit error types, comments that explain
  contracts and reasons. The tree is not uniformly `rustfmt`-formatted.
- Go: `gofmt` clean, one collector per file, collectors degrade to
  "unavailable" instead of failing a sample.
- Avoid emoji in code comments and commit messages.
