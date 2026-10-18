<div align="center" width="100%">
    <img src="./apps/dashboard/public/favicon.svg" width="96" alt="Flatline mark" />
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

Three pieces, one origin:

| Piece      | Dir               | What                                                                                                 |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| Backend    | `backend-rs/`     | Rust service: the check engine, REST API, storage, alerts, and the built web app.                    |
| Dashboard  | `apps/dashboard/` | React/Vite app: operator dashboard, Superboard, public status pages.                                 |
| Host agent | `superboard/`     | Single static Go binary pushed to each monitored server; sends telemetry, never accepts connections. |

`./dev.sh` runs all three locally, plus a mock fleet so the board has something
to show without real machines. Production is one container: the backend serves
the API, the dashboard, the status pages and the agent downloads on `:3001`.

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
- **Serve client status pages** with password gates, per-page logos and accents
  (`/status/:slug`, plus host-routed client domains). Serving and unlocking them
  is fully API-driven; creating or editing a page is currently a database
  operation — the admin API for pages was not ported.
- **Drive everything over HTTP**: the REST API is the same one the dashboard
  uses, and `GET /api/v1/openapi.json` documents itself.

![Operator dashboard with fictional applications and infrastructure](docs/screenshots/dashboard.png)

![Fictional CPU, RAM, GPU and VRAM history with p90, p95 and p99 summaries](docs/screenshots/history.png)

## Install

### Local development

Requires `cargo`, `go` and Node (Node is only the Vite dev server).

```bash
git clone https://github.com/qarasky/flatline.git
cd flatline
./dev.sh
```

`./dev.sh` builds the backend and agent, starts the dashboard on `:3003`
(backend on `:3001`, proxied), and starts the mock fleet: a Go agent that
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

One service on **3001** serving the API, dashboard, status pages and agent
downloads. Data lives in `./data`; on first run the operator token is written to
`./data/initial-token.txt` (0600) — sign in with it. There is no account setup
and no seed script.

### Without Docker

```bash
cargo run --release --manifest-path backend-rs/Cargo.toml
```

The backend serves the built dashboard from `FLATLINE_WEB_DIST`
(`apps/dashboard/dist`, built with `npm run build` there). Data is SQLite in
`./data`.

### Updating

```bash
git pull --ff-only
docker compose up -d --build
```

Back up the database first. Agents update themselves from the release the
server ships; see [docs/agent.md](docs/agent.md). The office deployment is
documented in [docs/deployment.md](docs/deployment.md).

## Sign in and tokens

Sign-in is a single token, pasted into the dashboard. There is one token type
and it has full permission — the dashboard's **Agents** panel mints additional
named tokens (shown once) so an integration can have its own revocable
credential, not to limit what it can do.

The same token authenticates the REST API and the tokenized provisioning
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
| [Dashboard](docs/dashboard.md)               | You are working on the operator UI.                        |
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
