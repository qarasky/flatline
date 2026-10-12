<div align="center" width="100%">
    <img src="./apps/dashboard/public/favicon.svg" width="96" alt="Flatline mark" />
</div>

# Flatline

Self-hosted uptime monitoring, live server telemetry, and Telegram alerts—built for shared operators and AI agents.

A fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma) (MIT), trimmed down to what a
small team actually uses and extended where it fell short. See [FORK-ROADMAP.md](./FORK-ROADMAP.md)
for the full list of changes.

![Superboard with eight fictional servers and compact container status tiles](docs/screenshots/superboard.png)

**All screenshots use generated sample data**, not a production installation.

## What you can do

- Monitor websites and services from a dense, keyboard-friendly dashboard.
- Watch CPU/RAM at 1Hz on **Superboard**, including per-core load, disk usage,
  optional GPU/VRAM, temperatures, and explicit telemetry freshness.
- Open a server's history with **10m / 1h / 6h / 24h / 7d** ranges and
  **p90 / p95 / p99**, mean, and peak summaries.
- Track containers in three-column status tiles with automatic vertical looping,
  pinned problems, and no manual scrolling. Host reachability stays separate
  from workload health.
- See pending OS update counts per host (`No updates` / `Updates: N` /
  `Security Updates: N`), read-only, from agent 1.3.
- Spot agent trouble at a glance: version, dropped samples, failed pushes and
  per-collector error counts travel in every payload and render on the card
  when something is off.
- Wall-mount a group of servers on its own kiosk page —
  `/superboard/kiosk/work` — while home shows every fleet on one board,
  or combine scopes with `/superboard/kiosk/work,personal`.
- Rename servers on the board directly (right-click → Rename).
- Share monitor data across accounts without sharing passwords or API tokens.
- Publish client status pages with password gates, branding, and group-driven
  generation; manage the installation through scoped REST calls.

### Operator dashboard

Grouped monitors, bulk actions, search (`/`), and live status updates.

![Operator dashboard with fictional applications and infrastructure](docs/screenshots/dashboard.png)

### Server history

Percentiles use archived readings (normally every 30 seconds), **not raw 1Hz
samples**. Charts show bucket averages; missing readings are not zeroes.
The card's **Peak 10m** tracks the highest total CPU load observed in the last
ten minutes, not the currently busiest core.

![Fictional CPU, RAM, GPU and VRAM history with p90, p95 and p99 summaries](docs/screenshots/history.png)

[Screenshot fixtures and regeneration instructions](docs/screenshots/README.md).

## What is different from upstream

- **Telegram only.** All 108 other notification providers were removed, along with the Webpush
  service worker and its VAPID infrastructure. Fewer moving parts, one way to be paged.
- **Multiple real users.** Flatline adds operator-issued, single-use invite links: mint a link, send it over any channel
  you already trust, the recipient picks their own password. No email required, no signup form.
- **REST API v1.** Everything the dashboard does is available over HTTP with bearer-token
  auth and per-token `read` / `write` / `publish` scopes, so scripts and LLM agents can drive it.
  `GET /api/v1/openapi.json` documents itself.
- **Shared instance.** There are no per-user silos: every operator sees and edits the same
  monitors, notifications and maintenance windows. Multiple accounts exist so panel access
  can be shared without passing around one password. Tokens and invite links stay per-user
  as the audit trail.
- **Flatline branding.** Hot-orange accent on warm near-black, following the palette of
  [1410666.xyz](https://1410666.xyz).

Retains upstream monitor types such as HTTP(s), TCP, DNS, Ping, Push, Docker,
SFTP, NTP, Postgres, and Redis, plus maintenance windows, proxy support, and 2FA.

## ⭐ Features

- Monitoring for HTTP(s), TCP, HTTP(s) Keyword, HTTP(s) Json Query, Websocket, Ping, DNS Record,
  Push, Steam Game Server, Docker Containers, gRPC, MQTT, PostgreSQL, MySQL, MS SQL, MongoDB,
  Redis, RabbitMQ, Kafka, SFTP, NTP, Oracle DB and more
- Telegram notifications with templates and MarkdownV2
- REST API v1 with token scopes and a self-describing OpenAPI document
- Multi-user with single-use invite links
- Multiple status pages, maintenance windows, tags, proxy support, 2FA
- Configurable check intervals; 1Hz host telemetry does not accelerate website checks

## Architecture

Three processes, one backend:

| App | Dir | Port | What |
|---|---|---|---|
| Backend (API only) | `server/` | 3001 | Monitors, checks, notifications, REST v1. Serves JSON, no HTML. |
| Public status site | `apps/status-site` | 3002 | Per-client status pages (Next.js). |
| Operator dashboard | `apps/dashboard` | 3003 | Dense monitor table, Superboard, users (Vite + React). |

The dashboard uses bearer-authenticated HTTP. Sign in with a username and
password to obtain a browser token; integrations use per-user API keys from
`POST /api/v1/api-keys` or the **Agents** panel. The status site reads the
status-page API; password-gated pages use page-scoped unlock cookies rather
than granting visitors operator access.

### Live updates

The operator dashboard and Superboard use bearer-authenticated SSE
(`/api/v1/events`) rather than roster polling. REST snapshots recover state on
connect/reconnect; heartbeat changes arrive as soon as checks finish.
External monitor check frequencies do not change.

[Superboard agent 1.4](superboard/README.md) pushes raw CPU counters at 1Hz
(the server derives utilization: responsive live, ~30s means in history),
1-second-fresh RAM, independent slower collectors, read-only pending-update
counts every 4h, and a Telegraf-style self-report (version, uptime, dropped
samples, collector errors) that cards surface as version + warning lines.
Latest samples are cached; live history is
sampled every 30s and retained for 30 days. Existing explicit agent intervals
are preserved until changed. Upgrade the backend before enabling 1Hz agents.

Use a single backend process. If reverse-proxying `/api/v1/events`, disable
response buffering and allow connections longer than the 15s keepalive.
For a repeatable isolated 10-server / three-client benchmark:

```sh
TEST_BACKEND=1 node --import=tsx extra/benchmark-live.mjs
```

The benchmark reports HTTP-ingest-to-stream latency, not remote collection or
browser paint latency. See [SUPERBOARD-SPEC.md](SUPERBOARD-SPEC.md) for limits
and restart/durability behavior.

## 🔧 How to Install

Documentation: [dashboard](apps/dashboard/README.md) ·
[agent installation](superboard/README.md) · [Superboard specification](SUPERBOARD-SPEC.md) ·
[single-origin deployment and rollback](docker/OFFICE-DEPLOYMENT.md) ·
[improvement backlog](IMPROVEMENT-ROADMAP.md).

### Local dev

Requires Node.js >= 26.2.0.

```bash
git clone https://github.com/qarasky/flatline.git
cd flatline
npm ci
./dev.sh
```

`./dev.sh` starts all three servers and seeds a demo database on first run.
Open the dashboard (address printed by the script) and sign in — on a fresh
database it asks you to create the first operator account. `./dev.sh stop`
stops everything; `./dev.sh status` checks health.

### 🐳 Docker

For the single-host office deployment behind Cloudflare Tunnel, use
[`compose.production.yaml`](compose.production.yaml) and the
[office deployment/rollback guide](docker/OFFICE-DEPLOYMENT.md).

```bash
git clone https://github.com/qarasky/flatline.git
cd flatline
docker compose up -d --build
```

This starts all three services: the API on **3001**, the dashboard on **3003**,
the status site on **3002**. Data lives in `./data`. On first run, open the
dashboard and create the operator account — no token pasting, no seed scripts.

Browsers reach the backend at `BACKEND_URL` (default `http://127.0.0.1:3001`;
`localhost` fails in some browsers over IPv6). Set it to the LAN host or
public origin when the browser is elsewhere:

```bash
BACKEND_URL=http://192.168.1.10:3001 docker compose up -d --build
```

Behind a reverse proxy, serve all three from one origin instead: the status
page unlock posts cross-origin otherwise, and the browser will not keep the
unlock cookie.

### 🐳 Docker Command

Backend only (the frontends have their own images — see `docker/`):

```bash
docker run -d \
  --restart=always \
  -p 3001:3001 \
  -v flatline:/app/data \
  --name flatline \
  artchsh/flatline:1
```

### 💪🏻 Non-Docker

Requires Node.js >= 26.2.0.

```bash
git clone https://github.com/qarasky/flatline.git
cd flatline
npm ci
npm run start-server-dev
```

Then run the frontend apps: `apps/status-site` and
[apps/dashboard](apps/dashboard/README.md), pointed at the backend URL.

Data is stored in `./data` (SQLite by default).

## 🔌 Quick start with the API

Create a token in the dashboard's **Agents** panel, optionally scoped to `read` only. Tokens are shown
once.

```bash
# What is broken right now?
curl -H "Authorization: Bearer uk1_..." http://localhost:3001/api/v1/health

# Create a monitor
curl -X POST http://localhost:3001/api/v1/monitors \
  -H "Authorization: Bearer uk1_..." \
  -H "Content-Type: application/json" \
  -d '{"name":"My API","type":"http","url":"https://example.com"}'

# Let an agent report its own check results
curl -X POST http://localhost:3001/api/v1/monitors/1/heartbeat \
  -H "Authorization: Bearer uk1_..." \
  -H "Content-Type: application/json" \
  -d '{"status":"up","ping":123}'
```

Point an agent at `http://localhost:3001/api/v1/openapi.json` and it can figure out the rest.

### Reading Superboard from an AI agent

A **read-scoped token** can inspect current metrics and historical percentiles
without operating a browser:

```sh
export FLATLINE_URL=https://flatline.example
# Set FLATLINE_TOKEN privately; do not paste real tokens into docs or source.
curl -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "$FLATLINE_URL/api/v1/monitors/metrics/latest?ids=1,2"
curl -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "$FLATLINE_URL/api/v1/monitors/1/metrics/summary?hours=24"
```

History summaries read the selected window, not merely the newest 1,000 rows.
They return at most 240 chart buckets and inspect at most 50,000 archived rows;
`capped: true` explicitly flags truncated statistics. The read API exposes up
to seven days, while retention is 30 days. Restarts may lose up to 30 seconds
of unarchived telemetry; recovered pre-restart CPU peaks use archived samples.

## 🆙 How to Update

```bash
git pull --ff-only
docker compose up -d --build
```

Back up the database before upgrades. For manually transferred production
images, follow the [deployment guide](docker/OFFICE-DEPLOYMENT.md) instead.

## Planned, not implemented

The ranked improvement list — with the comparable systems (Prometheus,
Netdata, Telegraf, Grafana Alloy, Beszel) each item is measured against —
lives in [IMPROVEMENT-ROADMAP.md](IMPROVEMENT-ROADMAP.md). Headline items:
agent self-telemetry and a disk-backed send buffer, threshold alerts,
multi-tier retention, network/disk-I/O metrics, per-container stats, and
SMART disk health.

Also outstanding: private aggregate saved status-page views; inherited
dependency advisories (separate hardening pass, see
[docker/OFFICE-DEPLOYMENT.md](docker/OFFICE-DEPLOYMENT.md)).

## 📜 Credits & licence

Built on [Uptime Kuma](https://github.com/louislam/uptime-kuma) by Louis Lam, MIT licensed.
This fork is released under the same licence; see [LICENSE](./LICENSE), which retains his
copyright notice.

Upstream project: <https://github.com/louislam/uptime-kuma>
