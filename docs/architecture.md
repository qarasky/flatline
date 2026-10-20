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

The database runs in WAL mode with `synchronous = NORMAL` (the safe setting for
WAL: a power cut can lose the last few commits, never corrupt the file), a 5 s
busy timeout and `journal_size_limit` = 64 MB, so the `-wal` file shrinks back
after a large delete instead of staying at its peak. SQLite has one write lock;
long maintenance work (heartbeat retention, monitor deletion, raw pruning) is
therefore done in bounded batches of short transactions, so pushes and check
loops waiting for the lock get it between batches.

| Table                                                                                                       | Holds                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `monitors`                                                                                                  | Monitor definitions, including agent-warning acknowledgements and the hosting `provider`.                             |
| `monitor_notifications`                                                                                     | Which notifications a monitor alerts through.                                                                         |
| `notifications`                                                                                             | Notification configs (Telegram only).                                                                                 |
| `heartbeats`                                                                                                | One row per check (push: ≤ 1 per `interval/3` s); retention `FLATLINE_HEARTBEAT_RETENTION_DAYS` (90 days; `0` = all). |
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
folded — so pruning can never run ahead of repair. A run consumes only the
markers it read (by id), so a marker written while a run is folding survives
for the next run; on-time samples mark their hour once, late samples every
time, in the same transaction as the raw row. The repair sweep's cursor only
advances after its window was folded, so a failed run retries the same window.
A raw row whose time does not parse can never be folded or read: the job skips
it rather than stopping, and the raw prune drops it once it sorts below the
retention cutoff.

Heartbeat retention runs ten minutes after boot (not alongside every check
loop's first beat) and daily at 04:32, per monitor in batches of 1000 rows,
always keeping each monitor's newest beat before the cutoff. Deleting a monitor
removes its telemetry and heartbeats in batches before the monitor row itself.

History windows above a week read the hourly tier; the response's `basis` field
says which tier answered, and percentiles describe hourly averages while `peak`
stays the true stored maximum.

## Check engine

Each active monitor runs one loop in the backend (`monitors/engine.rs`):
HTTP/ICMP checks, group aggregation, or the push watcher.

- **One loop per monitor.** Restarts (monitor edits) are generation-checked:
  overlapping restarts and a concurrent stop always end with at most one loop,
  and a replaced loop is aborted, never left running detached.
- **Supervised.** A panicking loop is logged and respawned with backoff (1 s
  doubling to 60 s). A watchdog checks every 5 s that each loop is still making
  progress, respawns any that are stuck, and stamps the tick `/healthz` reads.
- **Spread out.** At boot each loop waits a random offset in `[0, interval)`
  before its first check, so the fleet does not check (and hit the pool) in one
  burst per interval; drift-free scheduling keeps the offsets. Push watchers
  keep their interval-long boot delay instead.
- **Push watcher.** A push monitor times out on the age of the newest beat the
  _agent_ sent, whatever its status — an agent pushing `down` is alive. Ages are
  clamped at zero and also tracked on the monotonic clock, so a backwards
  wall-clock step cannot hide a silent agent; a fresh beat never schedules the
  next check more than `interval + 1 s` ahead.
- **Database errors** retry after 5 s (or the interval, if shorter) instead of
  waiting a full interval.
- **Serialized recording.** Recording a heartbeat (read the previous beat,
  decide the transition, insert) holds a per-monitor lock, so the push route
  and the push watcher cannot both record the same transition.

### Uptime windows

The 24 h / 7 d / 30 d ratios are time-weighted (a status holds until the next
beat; only UP and DOWN count). The engine keeps them in memory as a list of
_status runs_ per monitor — one entry per transition, so a healthy monitor has a
handful — loaded once with a 30-day scan and then extended by every beat it
records. Reads compute the three windows from the list without a query. A gap
in the chain (a beat written around the engine) drops the entry for a reload,
and a background maintainer warms monitors one at a time at boot and reloads
one stale entry per 5 s tick (each entry every 6 h). A monitor flapping past
100 000 runs falls back to a cached scan refreshed every 5 minutes.

### Alert delivery

Transitions that page are queued, never sent inline. One dispatcher builds the
messages in transition order and appends them to a queue per Telegram chat; one
worker per chat sends them in order behind a token bucket (a burst of 3, then
one every 3 s, below Telegram's per-chat limits). A `429` waits out the
provider's `retry_after` and retries the same message, so a DOWN can never
arrive after the UP that followed it. When four or more alerts are waiting, the
backlog goes out as one summary listing each alert's headline in order; a queue
holds at most 200 alerts, and the summary says how many of the oldest were
dropped. Metric threshold alerts share the same queues.

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

The newest telemetry sample per monitor is cached in-process (bounded, 2048
monitors, least recently updated evicted first) so the metrics endpoints and the
SSE stream never need a query for "right now". REST falls back to the archived
rows after a restart or eviction. A graceful shutdown archives each monitor's
newest unarchived sample, so only a crash loses the unarchived window (~30 s of
samples). Restart-recovery information is warmed from the archived snapshots:
the 10-minute CPU peak, and the 30 s archive clock (so a monitor that was
evicted does not archive every push until it re-warms).

Live events are serialized once when published and shared by every open stream
(a 4096-event buffer, about 40 s at 100 agents); a stream that still falls
behind is closed and the client reconnects. `?metrics=0` streams skip metrics
events without touching their payload.

## Shutdown

On `SIGTERM` or Ctrl-C one shared token stops everything, in about 16 s at
worst (the compose file grants 30 s before `SIGKILL`):

1. SSE streams end at once and the HTTP server drains for at most 3 s; check
   loops stop within 2 s; the rollup and retention jobs are aborted (rollups are
   idempotent, so an interrupted run is redone next hour).
2. Queued alerts are delivered (backlogs coalesced into one summary per chat)
   until 12 s after the signal; anything left is logged as undelivered.
3. Unarchived live telemetry is written to `metrics_raw` (bounded at 2 s).
4. The database pool is closed (bounded at 2 s).

## Authentication model

Two credentials, deliberately:

- **Bearer tokens** for every operator-facing call. One token type with full
  permission; extra tokens exist to be individually revocable, not to be
  restricted. The first token is written to `initial-token.txt` on first start.
- **Push tokens** (`flatline_agent_push_...`) on individual monitors, used by
  the agent for `POST /api/push/{token}` and for the `/agent/*` downloads. A
  push token can only affect its own monitor's data and can only fetch releases,
  which makes the fleet self-describing without handing out operator
  credentials. Backup agents use their own `flatline_agent_backup_...` family
  under `/api/backup/v1`; the two are never interchangeable, and both are
  rejected by the operator API with an explicit `agent_token_on_operator_api`
  error.

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
