<div align="center" width="100%">
    <img src="./apps/web/app/icon.svg" width="96" alt="Flatline mark" />
</div>

# Flatline

Self-hosted uptime monitoring, live server telemetry, and Telegram alerts —
built for one operator, a wall monitor and AI agents.

A fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma) (MIT), trimmed
to what a small team actually uses and extended where it fell short. See
[docs/history.md](docs/history.md) for how it differs from upstream and what was
removed.

![Superboard with eight fictional servers and compact container status tiles](docs/screenshots/superboard.png)

**All screenshots use generated sample data**, not a production installation.

## What it is

Four pieces, one origin:

| Piece        | Dir             | What                                                                                                         |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------ |
| Backend      | `backend-rs/`   | Rust service: the check engine, REST API, storage, alerts and both agents' downloads.                        |
| Web app      | `apps/web/`     | Next.js app: operator UI, Superboard, public status pages.                                                   |
| Host agent   | `superboard/`   | Single static Go binary pushed to each monitored server; sends telemetry, never accepts connections.         |
| Backup agent | `backup-agent/` | Separate Go binary on servers whose data you back up: exports Postgres and S3/Garage, uploads to the server. |

`./dev.sh` runs the backend, the web app and the agent locally, plus a mock
fleet so the board has something to show without real machines. Production is
three containers behind one port: Caddy on `:3001` sends `/api/*`, `/agent/*`
and the other backend paths to the backend and everything else to the web app.
Both agents update themselves from the builds the server ships.

## What you can do

- **Monitor** HTTP/HTTPS endpoints, ICMP hosts, groups and agent-pushed servers,
  with retries, maintenance-safe retry windows and Telegram alerts.
- **Watch CPU/RAM at 1 Hz on the Superboard**, with per-core squares, RAM and
  disk rows, container tiles, pending-update counts, SMART warnings and explicit
  telemetry freshness. Wall-mount a group on its own kiosk page
  (`/superboard/kiosk/work`, comma-separate scopes) and rename servers from the
  board.
- **Link the websites a server hosts** to its card and see their status as chips,
  with hosting-provider logos drawn next to the card title.
- **Open a server's history** with 10m / 1h / 6h / 24h / 7d / 30d / 1y ranges and
  p90 / p95 / p99, mean and peak summaries. Windows beyond a week read hourly
  rollups (two-year retention); peak stays the true maximum.
- **Get paged on sustained resource pressure**: per-server CPU/RAM/disk
  thresholds evaluated server-side, with 60s debounce, 30-minute cooldown,
  hysteresis and explicit recovery messages.
- **See agent trouble at a glance**: version, dropped samples, failed pushes and
  per-collector error counts on the card, with one right-click action to clear
  the warnings you have seen.
- **Back up client servers**: named backup agents export each project's Postgres
  databases and S3/Garage buckets daily to the Flatline server's storage, with
  optional age encryption, resumable uploads, retention and offline
  verify/restore. The Superboard shows each server's backup-agent version and a
  live "last backup … ago" line per project, and flags a server whose backup is
  overdue or failed.
- **Serve client status pages** with password gates, per-page logos and accents
  (`/status/:slug`, plus host-routed client domains). Serving and unlocking them
  is fully API-driven; creating or editing a page is currently a database
  operation — the admin API for pages was not ported.
- **Drive everything over HTTP**: the REST API is the same one the web app
  uses, and `GET /api/v1/openapi.json` documents itself.

![Operator dashboard with fictional applications and infrastructure](docs/screenshots/dashboard.png)

![Fictional CPU, RAM, GPU and VRAM history with p90, p95 and p99 summaries](docs/screenshots/history.png)

## Install

### Local development

Requires `cargo`, `go` and Node (Node runs the web app; the backend and the
agents do not use it).

```bash
git clone https://github.com/qarasky/flatline.git
cd flatline
./dev.sh
```

`./dev.sh` builds the backend and agent, starts the backend on `:3001` and the
web app on `:3003` (which forwards `/api` and `/agent` to the backend, so the
browser sees one origin), and starts the mock fleet: a Go agent that
creates a demo set of hosts through the public API, pushes believable telemetry,
creates a few demo websites and leaves agent warnings on two hosts. It prints
the operator token — also in `./.dev-data/initial-token.txt`. `./dev.sh stop`
stops everything; `./dev.sh status` checks health.

### Docker

```bash
git clone https://github.com/qarasky/flatline.git
cd flatline
docker compose up -d --build
```

Three containers, one published port (**3001**, set with `FLATLINE_BIND` and
`FLATLINE_PORT`): `caddy` routes the backend's paths to `flatline` (the API,
check engine and agent downloads) and everything else to `web` (the Next.js
app); only Caddy is published. Data lives in `./data`; on first run the
operator token is written to `./data/initial-token.txt` (0600) — sign in with
it ("Use a token instead") and create the first account. There is no seed
script.

Backup storage is opt-in: to accept uploads from backup agents, provision a
storage directory and add `-f docker/compose.backups.yaml` to every
`docker compose up` (see
[docs/deployment.md](docs/deployment.md#backup-storage)). Without it, backup
uploads answer 503 and everything else works.

### Without Docker

There is no one-binary mode: the backend no longer serves a web app. Run three
things:

- the backend: `cargo run --release --manifest-path backend-rs/Cargo.toml`
  (data is SQLite in `./data`);
- the web app: `npm run build:web`, then `npx next start` in `apps/web/` (or
  the standalone server `apps/web/server.js` from `.next/standalone/`, laid out
  as [`docker/web.dockerfile`](docker/web.dockerfile) does), with `API_URL`
  pointing at the backend;
- a reverse proxy in front of both, routing as
  [`docker/Caddyfile`](docker/Caddyfile) does: `/api/*`, `/agent/*`, `/healthz`,
  `/add-push-server.md`, `/llms.txt` and `/robots.txt` to the backend,
  unbuffered; everything else to the web app.

### Updating

```bash
git pull --ff-only
docker compose up -d --build
```

Back up the database first. Both agents update themselves from the release the
server ships; see [docs/agent.md](docs/agent.md) and
[docs/backup-agent.md](docs/backup-agent.md#self-update). The office deployment is
documented in [docs/deployment.md](docs/deployment.md).

## Sign in and tokens

People sign in to the web app with an email and password (member accounts,
added on **Members**), or with an operator token. There is one level of access:
every account and every token has full permission. **Tokens** mints additional
named tokens (shown once) so an integration can have its own revocable
credential, not to limit what it can do.

An operator token authenticates the REST API and the tokenized provisioning
documents:

```bash
export FLATLINE_URL=http://localhost:3001
# Set FLATLINE_TOKEN privately; never commit or paste a real token.
curl -H "Authorization: Bearer $FLATLINE_TOKEN" "$FLATLINE_URL/api/v1/health"

# The provisioning runbook, ready to hand to a human or an LLM agent:
curl "$FLATLINE_URL/add-push-server.md?token=$FLATLINE_TOKEN"
```

`/llms.txt` is the same pointer file in `llms.txt` form. Both embed the token,
so they are token-gated rather than crawlable.

## Documentation

Everything lives in [`docs/`](docs/README.md):

| Document                                     | Read it when                                               |
| -------------------------------------------- | ---------------------------------------------------------- |
| [Architecture](docs/architecture.md)         | You want to know how the pieces fit and where data lives.  |
| [API](docs/api.md)                           | You are calling Flatline from a script or an agent.        |
| [Host agent](docs/agent.md)                  | You are installing, configuring or debugging `superboard`. |
| [Superboard](docs/superboard.md)             | You are changing or explaining the wall board.             |
| [Web app](docs/dashboard.md)                 | You are working on the operator UI.                        |
| [Status pages](docs/status-pages.md)         | You are publishing or theming a public page.               |
| [Deployment](docs/deployment.md)             | You are shipping a release to a server.                    |
| [Operations](docs/operations.md)             | You are backing up, rotating a token or rolling back.      |
| [Development](docs/development.md)           | You are running, testing or releasing the code.            |
| [Provisioning runbook](docs/provisioning.md) | You are adding hosts (also served by the API).             |
| [Roadmap](docs/roadmap.md)                   | You want to know what is deliberately not done.            |
| [History](docs/history.md)                   | You want to know what changed from upstream Uptime Kuma.   |
| [Screenshots](docs/screenshots/README.md)    | You want the images and how they were made.                |

## Credits and licence

Built on [Uptime Kuma](https://github.com/louislam/uptime-kuma) by Louis Lam,
MIT licensed. This fork is released under the same licence; see
[LICENSE](./LICENSE), which retains his copyright notice.

Security reporting: [.github/SECURITY.md](.github/SECURITY.md).
