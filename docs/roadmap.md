# Flatline — roadmap

What is **not** done, grouped by theme, each item with a one-line rationale.
This consolidates the open items that were scattered across the planning
documents removed on 2026-10-18 (the improvement backlog, the Superboard and
status-page specs, the rewrite plan and the parity record). Items already
shipped are not relisted; where a shipped item is useful context it appears in
the "recently shipped" line.

Current state (for calibration): Rust backend, one React/Vite SPA (dashboard +
public status pages — see [architecture](architecture.md)), and a Go agent
([agent](agent.md), [superboard](superboard.md)) on each host. The scope of the
Rust rewrite was deliberately frozen — see [history](history.md). Deployment
and operations context: [deployment](deployment.md), [operations](operations.md).

**Recently shipped (context only):** agent self-telemetry and a disk-backed
send buffer (agent 1.4), server-side threshold alerts (Phase 5), multi-tier
retention (hourly min/max/avg for two years), Load/network/disk-I/O collection,
per-container one-shot CPU/memory stats, SMART disk health, agent self-update
(1.7+), and all 24 performance/stability review findings.

## Telemetry & history

| Item                                             | Rationale                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-container CPU/memory **history** and streams | One-shot stats ship per Docker refresh, but there is no per-container time series or live stream — the "which container is eating the box over time" question is unanswered |
| Dedicated **network / disk-I/O history charts**  | Raw counters are collected and live rates derived, but the card shows only CPU/RAM/disk and there is no historical throughput chart                                         |
| **Per-minute (Netdata-style) storage tiers**     | Retention is 30s raw for 30 days plus hourly for two years; there is no intermediate tier, so week-scale history is coarse                                                  |

## Agent & fleet

| Item                           | Rationale                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker event subscriptions** | The agent polls the Docker API; it does not subscribe to daemon events, so container start/stop/die transitions are only observed on the next poll |

## Backups

| Item                              | Rationale                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Off-site copy**                 | Client bundles and the nightly database live on the office RAID1 mirror only; a fire, theft or a two-disk failure loses them. Kore is a candidate destination                         |
| **Application config in bundles** | Bundles carry Postgres and S3 data, not compose files, `.env` secrets or Garage configuration, so a full host rebuild needs those from elsewhere                                      |
| **Scheduled restore drills**      | Restores are proven by hand on office (operations runbook); nothing re-tests them periodically                                                                                        |
| **Self-update review leftovers**  | Deferred minors from the 2026-10-25 review: the lock wait ignores SIGTERM, no size cap on release downloads, staging dir shared with an instance named `update`, opt-out checked late |

## Monitors, tags & API surface

| Item                                                                                       | Rationale                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tags**                                                                                   | Dropped from the Rust v1 surface; the API returns `tags: []`. The production status page has `show_tags = 0`, so nothing renders differently today, but the feature does not exist                                                                              |
| **Certificate-expiry fields** (`certExpiryDaysRemaining`, `validCert`) and group `sendUrl` | Explicitly out of the Rust v1 surface; the monitor list/detail does not expose TLS certificate expiry                                                                                                                                                           |
| **Monitor types beyond push / http / https / ping / group**                                | The rewrite locked scope to what the fleet measures; ~24 upstream types (TCP, DNS, MQTT, Docker, Postgres, MySQL, MongoDB, Redis, Kafka, SFTP, NTP, Oracle, gRPC, Steam, Websocket, keyword/JSON, …) were never ported. Revisit only if a measured need appears |
| **Maintenance windows**                                                                    | Dropped from the Rust v1 surface along with tags. Whether they will return is not stated in the current sources — treat as unresolved rather than scheduled                                                                                                     |
| **Status-page authoring CRUD**                                                             | The Rust backend keeps only a read-only status-page API (config, heartbeats, incidents, unlock); creating pages and editing incidents via REST was left "until a later pass", so pages are effectively frozen                                                   |

## Alerts & notifications

| Item                               | Rationale                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Group-level threshold defaults** | Per-monitor CPU/RAM/disk thresholds ship; group-level defaults were deliberately left out of that pass                                                                            |
| **Notification configuration UI**  | Telegram config arrives through the importer and is edited over the API; the rewrite plan flagged a "tiny settings form" as an optional follow-up and it is not recorded as built |

## Status pages

| Item                                          | Rationale                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private aggregate saved status-page views** | A dashboard-only aggregate across all groups was specced but is "still specced, not scheduled"; it is deliberately not a public `status_page` |

## Security & hardening

| Item                              | Rationale                                                                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dependency-advisory hardening** | Carried over as an outstanding pass. The Node backend's removal shrank the npm surface substantially, but no dedicated audit of the remaining Rust crates has been recorded — verify which advisories still apply before starting |

## Explicitly out of scope (deliberately not planned)

| Idea                                     | Why not                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Pull-based scraping                      | Clients are NAT'd; push is the documented, intended transport                                         |
| Multi-user silos / OAuth / OIDC          | The shared-instance model is deliberate                                                               |
| Clustering / HA / parent aggregation     | Needless at the documented fleet size (≤ 10–50); a single backend process is a documented limit       |
| Edge anomaly detection (Netdata-style)   | Too much machinery for a wall board; thresholds cover the need                                        |
| Log shipping                             | Explicitly out of product scope from day one                                                          |
| Rebuilding upstream push-retry semantics | Upstream's own tracker shows it is a tarpit; Flatline's silence-based host-down is simpler and honest |

## Not open items (noted so they are not mistaken for gaps)

- **Pending reboot indicator** — shipped for the two common families
  (Debian/Ubuntu `/run/reboot-required` and `needs-restarting -r`); a distro
  with neither reports nothing rather than guessing.
- **The old ranked backlog (items 1.1–3.3)** — all ticked: agent self-telemetry,
  disk buffer, threshold alerts, multi-tier retention, network/disk-I/O,
  per-container stats, SMART.
- **REST token mint/revoke and monitor pagination** — shipped in the Rust
  backend (`/api/v1/api-keys`, `?page`/`?perPage` on `/monitors` and
  `/incidents`); the Node-era "not done" notes no longer apply.
