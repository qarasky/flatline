# Flatline — history

A durable record of what this project is, what it deliberately removed and
added relative to upstream, how the Node backend was replaced by a Rust one,
what the performance reviews found, and what has been retired. It is written
for someone who was not present. For current architecture, deployment and
operations see [architecture](architecture.md), [deployment](deployment.md),
[operations](operations.md), [agent](agent.md) and [superboard](superboard.md).

## What Flatline is

Flatline is a personal fork of [Uptime Kuma](https://github.com/louislam/uptime-kuma)
(MIT). Upstream is left untouched and no pull requests are sent back; the fork
keeps upstream's `LICENSE` and Louis Lam's copyright and adds its own.

The runtime stack as of 2026-10-18:

| Piece   | Path              | Notes                                                                                                   |
| ------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| Backend | `backend-rs/`     | Rust: `axum` + `tokio` + `sqlx`/SQLite, one binary serving API + dashboard + status pages on one origin |
| Web app | `apps/dashboard/` | React/Vite SPA: operator dashboard, Superboard, Agents panel, public status-page routes                 |
| Agent   | `superboard/`     | Go single static binary on each monitored host; pushes telemetry                                        |

The original fork inherited, and then progressively deleted, a Node/Express
backend, the Vue frontend, a separate Next.js status app, most notification
providers and most monitor types (see "Retired things" below).

## How it differs from upstream

The fork's deliberate aim was to trim Uptime Kuma to what a small team
actually uses and then extend the parts it fell short on. Upstream's
contributor-policy and CI files were removed too — this is a solo fork that
merges straight to `master`, so `.github/` now holds only
`copilot-instructions.md`, `SECURITY.md` and `opencode-models.json` (the
upstream workflows, issue templates, `AGENTS.md`, `CLAUDE.md`, Dependabot and
funding config were all deleted). The underlying advice still applies: run the
local lint and tests, because nothing enforces them any more.

| Area          | Upstream Uptime Kuma                                   | Flatline                                                                                                                                                                    |
| ------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users         | Multi-user with roles; self-signup disabled by default | **Shared instance**: every operator sees and edits the same data. Accounts, invite links and per-user silos existed in the Node era and were removed with the Rust rewrite  |
| Auth          | Sessions, API keys, token scopes, 2FA/TOTP             | **One token type, full permission**; sign in with the operator token; API keys are SHA-256 at rest (imported keys keep their bcrypt hashes so existing automation survives) |
| Notifications | ~110 providers                                         | **Telegram only** (108 non-Telegram providers deleted, plus the Webpush service worker and VAPID infrastructure)                                                            |
| Frontend      | Vue 3 Options API (182 `.vue` components)              | One React/Vite SPA for dashboard **and** public status pages                                                                                                                |
| API           | Read-only badges, basic-auth + API-key                 | **REST API v1** with bearer-token auth and a self-describing OpenAPI document; agentic provisioning endpoints                                                               |
| Monitor types | 29 advertised types                                    | `push`, `http`, `https`, `ping`, `group` only; the rest were not ported                                                                                                     |
| Telemetry     | None                                                   | Go-agent push pipeline, Superboard, threshold alerts, two-tier retention                                                                                                    |

Additions that were later retired are listed under "Retired things".

## Migration: Node backend → Rust backend

### Why it was assessed

A separate assessment document (2026-10-12, since removed) weighed the rewrite
_before_ any code. The Node runtime was already reduced to one process by the v2
consolidation, so it was "not slow, not unstable". The realistic gains were
supply chain (102 direct npm deps, ~599 MB `node_modules`, a steady advisory
stream), deployment weight (tens of MB vs ~150 MB+), and dropping the Node
version/`tsx` loader friction; the honest estimate was still a multi-month
project with a long tail. Of three migration shapes, the assessment recommended
**shape C — a feature-freeze rewrite** covering only what is actually used,
since the fork had already deleted the Vue frontend and 108 notification
providers. The Go agent was **not** rewritten.

### Locked scope of the rewrite

Scope was frozen with the operator on 2026-10-12. **In:** monitors `push`,
`http(s)`, `ping` (added after import validation found the fleet's three ICMP
monitors) and group containers; the monitor table and detail/history,
Superboard and the Agents panel; HTTP scheduling with retries, uptime windows,
Telegram notifications when a monitor is configured for it, push-timeout
detection; the exact Go-agent push contract (`/api/push/:token?telemetry=1`);
the full Phase 1–5 metrics pipeline (counter transforms, `sampledAt` backfill,
archive gating, hourly rollups, threshold alerts, live cache, SSE deltas,
`cpuPeak10m`, two-tier history summary); REST v1 + OpenAPI, status badges and
the push endpoint; token auth; and a new schema plus a one-time importer from
the old SQLite database.

**Out:** users, invites, TOTP, token scopes and roles; maintenance windows and
tags; Prometheus `/metrics` and the built-in cloudflared integration;
keyword/JSON checks and the other ~25 monitor types.

A minimal **read-only** status-page API was kept deliberately, so deployed
client URLs (`/status/clients`, host-mapped domains, password gates) survived
the cutover. Authoring pages and incident CRUD were left out of v1 — pages are
frozen until a later pass.

### Parity and cutover

The Rust backend was compared field by field against the Node backend serving
from **copies of the same production database**, with the write paths
exercised on both sides. The result on 2026-10-13 was **115/115 checks
passed**, covering auth, health, monitors (every field), heartbeats, metrics
(bulk/single/summary/raw), notifications, status pages, badges, the push
contract and the API-key lifecycle. Several deliberate differences were
reported as INFO, not failures: gap-sensitive 7d/30d uptime (Rust extends the
last known status through a gap; Node dropped gap minutes), Node's broken
`?status=` filter, the locked monitor-type subset, and out-of-scope tags and
certificate-expiry fields. The run surfaced and fixed two real defects (the
importer dropped INTEGER-typed `ping` values; `serde_json` truncated 17-digit
payload decimals until `float_roundtrip` was enabled). The importer was
validated against a consistent production copy: 34 monitors (three ping),
111k heartbeats, 73k metric rows, 29 API keys and the status page.

**Cutover ran on 2026-10-13.** The Cloudflare tunnel was pointed at the Rust
backend; the Node backend's database was not written to. The full parity record
lived in a file that has since been removed along with the Node backend; this
document is the surviving account. The office release of 2026-10-18 rebuilt the
image and recorded 36 monitors and 366k heartbeats; the fleet was on agent 1.6.1
with 1.7.0 shipped.

### Rollback: the lesson

The rewrite plan originally said the Node stack was stopped and **kept for
rollback**. That is no longer true: on **2026-10-18** the Node backend was
deleted from the repository, so **there is no Node rollback path** — nothing to
roll back to and no image is built for it any more.

The operational lesson is that a code rollback now also requires restoring a
**database backup**. The Rust backend uses `sqlx` migrations, and `sqlx`
refuses to start a binary that does not know a migration the database has
already applied (`VersionMissing`). Rolling the code back therefore needs a
matching pre-upgrade database: retag the previous image, restore the matching
`.db` over `data-rust/flatline.db`, then recreate the stack (the
`pre-1.7.0-20261017-233721.db` backup and `office-prev-20261017` tag are an
example). Back up before every migration-bearing release.

## Performance and stability reviews

Two repository-wide reviews of execution paths and failure modes ran in
October 2026 (security and dependency findings excluded): one at revision
`a742b498` on 2026-10-13 recording 17 findings (P1 = can stop monitoring or
delivery, or lose history; P2 = conditional availability, misleading behaviour,
leaks or scaling regressions), and a follow-up at revision `2f91ecad` on
2026-10-14 recording 7 more, checking the earlier fixes for remaining gaps.
Both documents have since been removed; this table is the surviving record. All
24 were fixed, one commit each, each with a regression test for its failing
scenario. Rather than restating them, the classes of defect and their fixes:

| Failure mode                                                                                                                                                      | Class                      | Fix                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Hourly rollups judged coverage by hour (not per monitor+hour), ignored older backfills, and a late backfill could rebuild a complete bucket from partial raw rows | History loss               | Track coverage per `(monitor, hour)`; mark dirty hours; prune hour-aligned and never rebuild over an existing richer bucket   |
| Raw pruning ran independently of rollup, so evidence could be deleted before it was folded                                                                        | Permanent history loss     | Repair-before-prune: folding and the raw prune are one maintenance run; prune only pairs a bucket covers, report `skippedRaw` |
| A permanently rejected sample (400/413) blocked the agent's whole buffered queue                                                                                  | Delivery stall             | Quarantine permanent rejects (counted), keep the backlog for credential errors, retry transients                              |
| Postgres/gRPC, then Redis/MySQL checks could wait forever                                                                                                         | Monitoring stall           | Connection/operation deadlines; cancel and close on expiry                                                                    |
| A hung Telegram request froze a monitor before the heartbeat persisted                                                                                            | Monitoring stall           | Bounded 30s notification deadline; heartbeat persists independently of delivery                                               |
| A hung dashboard REST snapshot disabled SSE recovery                                                                                                              | Availability               | Deadlines + cancellation on snapshots; stream recovery independent of snapshots                                               |
| Failed/transient notification deliveries were dropped, and shutdown did not flush                                                                                 | Lost alerts                | Bounded retry queue (3 attempts, backoff, Telegram `retry_after`), shutdown drain, health counters                            |
| Every rollup recounted the entire raw retention window                                                                                                            | Scaling                    | Dirty buckets + durable repair cursor; full comparison once after upgrade                                                     |
| Rust recomputed 30-day uptime on the heartbeat publication path                                                                                                   | Scaling                    | Stale-while-revalidate + single-flight background refresh per monitor                                                         |
| Docker collection walked containers sequentially with no deadline, so old container health looked fresh                                                           | Misleading monitoring      | One 20s budget on a 4-worker pool; keep previous list and report age (`dockerAt`)                                             |
| A nameless Docker entry panicked the agent; MongoDB/gRPC clients leaked                                                                                           | Crash / leak               | Validate before indexing; close clients in `finally`                                                                          |
| Rust heartbeats had no retention; latest-heartbeat reads scanned full history                                                                                     | Unbounded growth / scaling | 90-day retention (configurable) preserving a boundary sample; indexed `LIMIT 1` lookups                                       |
| Concurrent ingestion bypassed the 30s archive gate; alert debounce counted sub-threshold time; stale backfill could raise current alerts                          | Correctness                | Serialize ingestion per monitor; restart debounce on sub-threshold time; archive-but-pause stale samples                      |
| Login lost its token when browser storage failed; legacy zero-timeout fallback multiplied by 1000 twice                                                           | Availability / bug         | In-memory token copy; normalize the timeout fallback                                                                          |

On the agent side, `failedPushes` was redefined to mean **lost** samples
(quarantined rejects and fallback failures) rather than every retried failure,
and `collectorErrors` counts failure **episodes** per collector rather than
every attempt — so a backend restart or tunnel blip no longer makes warnings
climb forever, while a genuinely broken collector contributes one.

## Retired things

| Retired                                                   | When / why                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node/Express backend (`server/`)                          | Replaced by `backend-rs/` at the 2026-10-13 cutover; deleted 2026-10-18, so no rollback path remains                                                                                                                           |
| Vue 3 frontend (`src/`, 182 components)                   | Replaced by `apps/dashboard/` at the v2 consolidation (2026-10-12)                                                                                                                                                             |
| Standalone Next.js status site (`apps/status-site`)       | Collapsed into the dashboard SPA; the backend serves the built app itself                                                                                                                                                      |
| Accounts, users, invite links, per-user scopes/roles      | The Node-era fork added single-use invite links; the Rust rewrite dropped them for a shared instance with **one full-permission token type**                                                                                   |
| 108 non-Telegram notification providers                   | Telegram only; orphaned DB rows now raise a named error instead of a bare "not supported"                                                                                                                                      |
| Webpush provider + `serviceWorker.js` + VAPID             | Removing it kept "Telegram only" consistent                                                                                                                                                                                    |
| Monitor types never ported                                | Everything except `push`, `http`, `https`, `ping`, `group` (TCP, DNS, MQTT, Docker, SFTP, NTP, Postgres, MySQL, MSSQL, MongoDB, Redis, RabbitMQ, Kafka, Oracle, gRPC, Steam, Websocket, keyword/JSON, …)                       |
| `client-cli/` SSH launchers                               | Credential-store launchers used during early provisioning; superseded by the served installer, removed 2026-10-18                                                                                                              |
| Upstream contributor policy and CI                        | 21 workflows, issue/PR templates, review guidelines, Dependabot and funding config                                                                                                                                             |
| `extra/` (healthcheck, push examples, `uptime-kuma-push`) | Upstream Node-era helpers for the Kuma image and legacy push scripts; removed 2026-10-18                                                                                                                                       |
| Planning and audit documents                              | The assessment, rewrite plan, parity record, both performance reviews and the fork/improvement roadmaps were folded into this document and [roadmap](roadmap.md), then removed, so there is one place to read rather than six. |

## Reading the history of a specific behaviour

When something is removed, the reason goes in the table above; when something is
_planned_, it goes in [roadmap](roadmap.md). Anything not in either place is
current behaviour, documented in [architecture](architecture.md),
[superboard](superboard.md) and [agent](agent.md).
