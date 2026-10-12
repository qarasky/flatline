# Flatline — Improvement backlog

Ranked backlog from the October 2026 architecture review: every item was
checked against comparable systems rather than invented in a vacuum. Work top
to bottom, one item at a time. Each item is shippable and testable alone, with
its own spec/docs/tests update in the same change, and gets ticked here when
shipped (and listed in the deploy record once rolled out).

## Status

- [x] 1.1 Agent self-telemetry — shipped in agent 1.4.0
- [x] 1.2 Disk-backed send buffer — shipped in agent 1.4.0 (with server-side `sampledAt`)
- [x] 2.1 Threshold alerts — shipped server-side (Phase 5)
- [x] 2.2 Multi-tier retention — shipped (hourly min/max/avg, two years)
- [x] 3.1 Network throughput, disk I/O, load average — shipped (live rates; no dedicated history charts yet)
- [x] 3.2 Per-container CPU / memory — shipped (one-shot stats per refresh; no streams or per-container history)
- [x] 3.3 SMART disk health — shipped (smartctl, 6h refresh, NVMe wear only)

## Where we already match the field

Validated by the review — keep these decisions, they are not gaps:

| Decision | Precedent |
|---|---|
| Push-only transport from agents | [Prometheus: when to use the Pushgateway](https://prometheus.io/docs/practices/pushing) — push is correct exactly for jobs behind NAT that cannot be scraped. Our clients have no inbound ports, so push is the intended shape, not an anti-pattern |
| Raw cumulative counters, server-side rate math | [Prometheus instrumentation practices](https://prometheus.io/docs/practices/instrumentation) and node_exporter: forward counters, never precomputed gauges. Shipped in agent 1.3 |
| Freshness separate from reachability | Compensates for the one thing push genuinely loses, the automatic scrape-`up` signal ([Prometheus FAQ](https://prometheus.io/docs/introduction/faq)) |
| Single backend process | Documented limit; fine at fleet ≤ 10–50. Revisit only if the fleet outgrows it |

## References

| System | Sources | What it teaches us |
|---|---|---|
| **Prometheus** | [Pushgateway practices](https://prometheus.io/docs/practices/pushing), [FAQ](https://prometheus.io/docs/introduction/faq), [Agent mode](https://prometheus.io/docs/prometheus/latest/prometheus_agent) | Push failure modes; agent-mode WAL; counters-not-gauges |
| **Netdata** | [Learn: design & parents](https://learn.netdata.cloud/docs/welcome-to-netdata), [Wikipedia architecture](https://en.wikipedia.org/wiki/Netdata) | Multi-resolution storage tiers; parent aggregation; edge collection |
| **Telegraf** | [Metrics concepts](https://docs.influxdata.com/telegraf/v1/concepts/metrics), [internal self-stats input](https://github.com/influxdata/telegraf/blob/master/plugins/inputs/internal/README.md) | Pipeline stages; first-class agent self-telemetry (`gather_errors`, `metrics_dropped`, …) |
| **Grafana Alloy / Agent mode** | [Alloy metrics docs](https://grafana.com/docs/alloy/latest/collect/prometheus-metrics), [Alloy as gateway](https://grafana.com/docs/grafana-cloud/send-data/alloy/introduction/how-alloy-works) | Collector components; forwarder with disk-backed retry |
| **Beszel** | [beszel.dev](https://beszel.dev/), [GitHub](https://github.com/henrygd/beszel) | Closest analogue (hub + Go agent + SQLite): container stats, SMART, network/disk I/O, threshold alerts |
| **Uptime Kuma upstream** | [#1863](https://github.com/louislam/uptime-kuma/issues/1863), [#6586](https://github.com/louislam/uptime-kuma/issues/6586) | Inherited push-retry semantics remain a known mess upstream; avoid rebuilding them |

---

## Tier 1 — Agent robustness

### 1.1 Agent self-telemetry

- **Status:** shipped in agent 1.4.0 (2026-10-12). Deviations from the sketch
  below: `lastPushOk` was dropped as redundant (the sample timestamp already
  proves delivery), replaced by `uptime` (crash-loop detection) and
  `lastError` (cause of the most recent push failure, cleared on success).
  Counts are backed by atomic counters and ride every payload including
  `superboard check`; only nonzero collector entries are serialized.
- **Why:** Telegraf treats agent health as a first-class metric
  (`gather_errors`, `gather_timeouts`, `metrics_dropped`, `metrics_written`).
  Today a broken collector only writes to journald: the board cannot tell
  "collector failing" from "quiet host", and we cannot see dropped samples or
  push failures from the server side at all.
- **Shape:** add an `agent` block to the payload — `{ version, schema,
  samplesDropped, pushFailures, lastPushOk, collectorErrors: { docker, gpu,
  updates, cpu, disk } }` (counts, no strings beyond short reasons). Render on
  the card (warning line, tooltip) and expose through the read API.
- **Notes:** version doubles as drift detection across the fleet — we upgraded
  six hosts by hand this month. Bump `payloadVersion` docs and spec §1.2.
- **Size:** S (agent counters + payload + card line + tests).

### 1.2 Disk-backed send buffer

- **Status:** shipped in agent 1.4.0 (2026-10-12). Shape as built: one file
  per sample (atomic temp+rename, 0600 in a 0700 dir, seq-named), oldest
  dropped past the byte cap, oldest-first drain paced at ~20 pushes/s,
  corrupt entries skipped and counted, crash debris cleaned on open,
  in-memory fallback when the directory is unusable, `uninstall` removes
  the directory. Server side: `sampledAt` accepted when sane (≤5 min future,
  within retention) with receive-time fallback, and archive gating now also
  fires on 30s of *sample time* so a drained backlog restores its real
  cadence instead of collapsing into a receive-time burst.
- **Why:** the last data-integrity hole. Today a capacity-one queue drops
  superseded samples: a backend restart or network outage erases the window,
  and an agent restart loses up to 30s of unarchived samples. All three
  collector systems solve this — Prometheus agent-mode WAL, Telegraf's disk
  buffer, Alloy's retrying forwarder.
- **Shape:** bounded on-disk queue (e.g. `/var/lib/superboard/buffer`, cap by
  bytes, oldest-dropped) for samples awaiting a successful push; sender drains
  it in order; live sampling continues regardless. Server already handles
  out-of-order arrivals (`monitor-metrics.js` time comparisons), so backfill
  is safe by construction — verify in tests.
- **Notes:** keep one file per sample or a simple JSONL log with ack marker;
  no external dependency. Must not lie about age: backfilled samples carry
  their original timestamps (server uses receive time only for archive
  throttling, which is fine for an outage burst).
- **Size:** M (agent queue + drain + tests + docs).

## Tier 2 — Operations & history

### 2.1 Threshold alerts (server-side)

- **Status:** shipped (2026-10-12), spec'd as SUPERBOARD-SPEC.md Phase 5.
  Deviations from the sketch: three nullable integer columns instead of a
  JSON blob; constants fixed (60s debounce, 5-point hysteresis, 30-minute
  cooldown) rather than configurable; evaluation uses receive time so a
  backfilled backlog cannot replay old alert timelines; maintenance
  suppresses delivery but not tracking; hysteresis band is deliberately
  silent (no repeat can claim "88% ≥ 90%"). No agent change required.
- **Why:** the biggest visible feature gap. Beszel's core value is exactly
  this; we deliberately ship host-down only, and maintenance windows exist but
  only gate heartbeat alerts. We now derive CPU/mem/disk/GPU server-side at
  ingest, so evaluation has a natural home and does not depend on agent logic.
- **Shape:** per-monitor thresholds (CPU %, RAM %, disk %, optional load)
  with debounce/cooldown; reuse the Telegram notification path and maintenance
  gating; alert-only first — no monitor status flips. State kept per monitor
  to prevent notification spam; explicit "ok" recovery message.
- **Notes:** spec it before building (± hysteresis, back-off, per-group
  defaults). Keep it out of the ingest hot path: async queue with bounded
  backlog.
- **Size:** M (db state + evaluator + notification hook + UI fields + tests).

### 2.2 Multi-tier retention

- **Status:** shipped (2026-10-12). As built: `monitor_metric_hourly` keeps
  one row per monitor per hour (min/max/avg per metric plus the number of raw
  readings) for two years; the hourly rollup job folds only complete hours,
  upserts on `(monitor_id, time)`, backfills the full raw window in chunks on
  first run, and re-rolls the last two complete hours so late/backfilled
  samples land. Summary windows ≤ 7d read raw; > 7d read hourly, where peak
  comes from the stored extremes (averages must not hide spikes) and
  percentiles describe hourly averages — the response's `basis` says which.
  API max extended to 17520 hours; the history dialog gained 30d and 1y
  ranges. Not done: per-minute tiers (Netdata-style); hourly is the tier the
  fleet needs first.
- **Why:** Netdata keeps per-second/per-minute/per-hour tiers; we store 30s
  samples for 30 days uniformly, so the board forgets everything past a month
  and the history API caps at 7 days. Fleet ops questions ("was this box
  always at 80% RAM?") deserve a cheap long tier.
- **Shape:** hourly rollup rows (min/max/avg per metric) kept long-term (e.g.
  2 years) alongside raw 30s; prune raw at 30 days as now; `metrics/summary`
  picks the resolution by requested window and keeps its `basis` field honest.
- **Notes:** SQLite-friendly: one aggregate table written by the existing
  hourly prune job. The read API already documents `capped` and `basis`, so
  the UI contract barely changes.
- **Size:** M (migration + rollup job + read switch + tests).

## Tier 3 — Metrics table stakes

### 3.1 Network throughput, disk I/O, load average

- **Status:** shipped in agent 1.5.0 (2026-10-12). As built: raw cumulative
  counters for network (per interface, loopback excluded) and disk I/O
  (whole disks only, partitions filtered), load average as a gauge. The
  server derives per-second rates between consecutive pushes and attaches
  them to the live sample (`netRate`/`diskIoRate`); history keeps the raw
  counters, and dedicated charts for these metrics remain future work. Gaps
  longer than 5 minutes yield no rate rather than a fake average; virtual
  interfaces are excluded when summing so container traffic is not double
  counted.
- **Why:** Beszel ships all three; load average is a headline number in every
  lightweight monitor. We have CPU/RAM/disk-space and nothing else.
- **Shape:** raw cumulative counters from `/proc/net/dev` and `/proc/diskstats`
  forwarded like CPU (server derives rates from consecutive snapshots);
  `/proc/loadavg` as a direct gauge. Card line + history fields.
- **Size:** M (agent collectors + server derivation + card + spec).

### 3.2 Per-container CPU / memory

- **Status:** shipped in agent 1.5.0 (2026-10-12). As built: one-shot stats
  per Docker refresh (10s) for running containers, on the existing socket
  client; CPU percent computed against the previous read (Docker's per-core
  convention, can exceed 100%), memory with cache subtracted and the cgroup
  v2 no-limit sentinel handled. Tiles show a compact `CPU · memory` label,
  tooltip carries the detail; absent stats mean unknown, never zero. Not
  done: stats streaming and per-container history.
- **Why:** our spec deferred stats streaming "in v1"; Beszel and cAdvisor both
  treat it as table stakes, and it is the question the container tiles raise:
  which container is eating the box.
- **Shape:** read stats per container on the Docker refresh tick (10s), attach
  to the existing container entries; tiles show a number when present.
- **Notes:** bounded by container count; skip statless/stopped containers;
  no per-container history in this pass.
- **Size:** M–L (docker stats parsing + payload growth + tiles + tests).

### 3.3 SMART disk health

- **Status:** shipped in agent 1.5.0 (2026-10-12). As built: `smartctl -j -H
  -A` per whole disk every 6 hours, parsed in-process (smartctl exit codes
  are a bitmask — a failing disk exits nonzero with valid JSON, so output is
  parsed regardless). Health from `smart_status`, temperature and power-on
  hours from either ATA or NVMe blocks, reallocated sectors from ATA
  attribute 5, wear from NVMe `percentage_used` only. The board warns on
  `failed` health (red) or ≥80% wear (amber), tooltip carries per-disk
  detail; healthy disks stay silent. Missing smartctl → `available: false`.
- **Why:** predictive disk failure is worth more than another percent chart,
  and Beszel ships it. Best-effort `smartctl` exec fits our collector pattern
  exactly (like `nvidia-smi`).
- **Shape:** per-disk `{ device, health, reallocatedSectors, wearPercent?,
  tempC? }` every few hours; card warning + tooltip. Failure → absent, never
  fabricated.
- **Size:** M (exec + parse + payload + card + tests).

---

## Out of scope (deliberately)

| Idea | Why not |
|---|---|
| Pull-based scraping | Clients are NAT'd; that is precisely the documented push use case |
| Multi-user silos / OAuth / OIDC | Shared-instance is deliberate; Beszel's multi-tenancy does not fit our ops model |
| Clustering / HA / parent aggregation | Needless at fleet ≤ 10–50; single backend is documented |
| Edge anomaly detection (Netdata-style) | Too much machinery for a wall board; thresholds cover the need |
| Log shipping | Explicitly out of product scope from day one |
| Rebuilding upstream push-retry semantics | Upstream's own tracker shows this is a tarpit ([#1863](https://github.com/louislam/uptime-kuma/issues/1863), [#6586](https://github.com/louislam/uptime-kuma/issues/6586)); our silence-based host-down is simpler and honest |

## Watch list

- **Dependency advisories** — inherited from upstream (12 in production);
  separate hardening pass with tests, not a blind `npm audit fix --force`.
- **Private aggregate saved views** — still specced, not scheduled.
- **Pending reboot indicator** — long uptime proves nothing; needs its own
  semantics before implementation (see SUPERBOARD-SPEC).
