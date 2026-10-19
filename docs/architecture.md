# Architecture

Flatline is three programs and one database.

| Process              | Language     | Runs on                           | Job                                                                                                                    |
| -------------------- | ------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Backend              | Rust         | The Flatline server               | Check engine, REST API, storage, alerts, and serving the built web app.                                                |
| Dashboard            | React + Vite | Build output in the backend image | Operator dashboard, Superboard, public status pages. Runs in the browser; in development it is a separate Vite server. |
| Agent (`superboard`) | Go           | Each monitored host               | Collects telemetry and pushes it outbound. Never listens on a port.                                                    |
| Backup agent         | Go           | Selected hosts                    | Exports PostgreSQL/Garage, encrypts locally, uploads resumable chunks. One process per named instance.                 |

There is no message broker, no Redis and no second service: one backend process
owns the SQLite database, the in-memory live cache and the HTTP surface.

## Request flow

```
browser ──HTTP/SSE──▶ backend ──SQLite──▶ data/flatline.db
                        ▲
agent ──POST /api/push──┘   (outbound only, per-monitor push token)
```

- The browser and the API are **same origin**: whatever host serves the app
  serves the API, so there is no backend URL to configure. A reverse proxy must
  disable response buffering for the SSE stream.
- The agent authenticates with the **push token of its own monitor**. There is
  no inbound path to an agent, so a client behind NAT needs no firewall change.
- The backend also serves the agent downloads and the provisioning documents
  (`/agent/*`, `/add-push-server.md`, `/llms.txt`) from the files baked into the
  image, so a client host updates itself from the same origin it reports to.

## Backend modules

| Module            | Responsibility                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `api/`            | The HTTP surface: routers, request validation, JSON shapes.                                                                       |
| `monitors/`       | The check engine — scheduling, HTTP/ICMP checks, retries, group aggregation, push-timeout detection.                              |
| `heartbeats.rs`   | Up/down history, uptime windows, retention.                                                                                       |
| `metrics/`        | Telemetry ingest, validation, counter/rate derivation, live cache, archival, hourly rollups, threshold alerts, history summaries. |
| `notify.rs`       | Telegram delivery and its templates.                                                                                              |
| `links.rs`        | Server → hosted-website links, including group expansion.                                                                         |
| `status_pages.rs` | Public status page data, host resolution, password gates.                                                                         |
| `auth.rs`         | Bearer tokens, push tokens, scope checks.                                                                                         |
| `provisioning.rs` | The runbook, installer, checksums and agent downloads.                                                                            |

## Data

SQLite, opened and migrated at startup (`sqlx::migrate!`, migrations in
`backend-rs/migrations/`). Backup metadata is stored in the same SQLite
database; encrypted bundles live under `FLATLINE_BACKUP_DIR`, never in the
application data directory. Migrations are additive and ordered; the database
records which have been applied, and the backend refuses to start if the
database contains a migration it does not know — so a code rollback also needs
the matching database (see [operations](operations.md)).

| Table                                                                                                       | Holds                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `monitors`                                                                                                  | Monitor definitions, including agent-warning acknowledgements and the hosting `provider`.                             |
| `monitor_notifications`                                                                                     | Which notifications a monitor alerts through.                                                                         |
| `notifications`                                                                                             | Notification configs (Telegram only).                                                                                 |
| `heartbeats`                                                                                                | One row per up/down/retry transition; retention `FLATLINE_HEARTBEAT_RETENTION_DAYS` (default 90 days, `0` = forever). |
| `metrics_raw`                                                                                               | Archived telemetry payloads, one per monitor per ~30 s, kept **30 days**.                                             |
| `metrics_hourly`                                                                                            | Hourly min/max/avg rollups with raw-reading counts, kept **730 days**.                                                |
| `metrics_rollup_dirty`, `metrics_rollup_state`                                                              | Rollup bookkeeping: which hours need re-folding and how far repair has progressed.                                    |
| `monitor_links`                                                                                             | Server → website links (direct, or via a group).                                                                      |
| `tokens`                                                                                                    | Bearer tokens, SHA-256 hashed; plaintext is shown once at mint time.                                                  |
| `status_pages`, `status_page_groups`, `status_page_monitors`, `status_page_cnames`, `status_page_incidents` | Public status pages and their content.                                                                                |

### Retention and rollups

Live telemetry is retained at 30-second resolution for 30 days, then folded
into hourly buckets (min/max/mean plus the number of raw readings) kept for two
years. The rollup job runs hourly and is idempotent, re-folding the last two
complete hours so late and backfilled samples land. Raw pruning only deletes a
sample once it is represented in an hourly bucket, and a _dirty hour_ marker is
written whenever a sample arrives late for an hour that may already have been
folded — so pruning can never run ahead of repair.

History windows above a week read the hourly tier; the response's `basis` field
says which tier answered, and percentiles describe hourly averages while `peak`
stays the true stored maximum.

## Live updates

The dashboard and Superboard hold one SSE connection to `/api/v1/events`:

- REST snapshots run on connect, on reconnect, and on a coalesced configuration
  invalidation (the backend publishes one whenever monitors, links, status pages
  or tokens change).
- Heartbeat and telemetry deltas are published as they are produced, so a check
  finishing on the backend reaches the wall without polling.
- The stream sends keepalives; a proxy must not buffer it and must allow idle
  connections beyond the keepalive interval.
- Token revocation, expiry and disabling are re-checked periodically on an open
  stream, so a revoked token stops working without waiting for a reconnect.

### The live cache

The newest telemetry sample per monitor is cached in-process (bounded, 512
monitors) so the metrics endpoints and the SSE stream never need a query for
"right now". REST falls back to the archived rows after a restart or eviction,
which means a restart can lose at most the unarchived window (~30 s of samples).
Restart-recovery information such as the 10-minute CPU peak is warmed from the
archived snapshots.

## Authentication model

Two credentials, deliberately:

- **Bearer tokens** for every operator-facing call. One token type with full
  permission; extra tokens exist to be individually revocable, not to be
  restricted. The first token is written to `initial-token.txt` on first start.
- **Push tokens** on individual monitors, used by the agent for
  `POST /api/push/{token}` and for the `/agent/*` downloads. A push token can
  only affect its own monitor's data and can only fetch releases, which makes
  the fleet self-describing without handing out operator credentials.

Public status pages are read through a separate, page-scoped path: published
pages are readable without a token, password-gated pages hand out a signed
unlock cookie, and neither grants operator access. See
[status pages](status-pages.md).

## Configuration

The backend reads its configuration from the environment:

| Variable                            | Default      | Meaning                                              |
| ----------------------------------- | ------------ | ---------------------------------------------------- |
| `PORT`                              | `3001`       | Listen port.                                         |
| `DATA_DIR`                          | `./data`     | SQLite database directory.                           |
| `UPTIME_KUMA_HOST`                  | `0.0.0.0`    | Bind address.                                        |
| `FLATLINE_WEB_DIST`                 | `./dist`     | Built web app to serve.                              |
| `FLATLINE_AGENT_DIR`                | —            | Directory of agent binaries served under `/agent/*`. |
| `FLATLINE_PUBLIC_URL`               | request host | Absolute origin used in the provisioning documents.  |
| `FLATLINE_HEARTBEAT_RETENTION_DAYS` | `90`         | Heartbeat retention; `0` keeps forever.              |

## Deliberate limits

- **Single backend process.** The live cache and alert state are in-process;
  running two backends against one database is not supported.
- **One notification channel.** Telegram only.
- **A small monitor surface.** `http`, `https`, `push`, `ping` and `group`.
  Upstream's other 20-odd monitor types were not ported.
- **Maintenance windows are not implemented.** Monitor status understands the
  maintenance state, but there is no maintenance-window API.
