# Flatline — Superboard

Spec for fleet monitoring: a tiny Go agent on each client server pushes system
metrics to Flatline, and a fullscreen NOC-style board shows every client at a
glance. Built for the wall monitor, not the desk: the operator should be able
to see from across the room why a server has high load — or just enjoy looking
at it.

Status: **shipped — Phases 1–5.** See "As built" at the end of each phase for
the differences between this design and the code.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Transport | Push only (outbound from client). No inbound ports, no client IPs in Flatline config, works behind NAT |
| Credential | Existing per-monitor `push_token`. No login, no user management on client boxes |
| Alerts v1 | Host-down only, through the existing push-timeout path. No threshold alerts |
| Containers v1 | List + healthy/up + exposed ports. No per-container CPU/mem |
| Editing | In the admin panel (where monitors are managed), plus display-name rename on the board itself |
| Board access | Separate page, auth-only (bearer token, same as the dashboard) |
| Board behaviour | Fullscreen, auto-paginating every ~5s (configurable) |
| Agent platform | Go, single static binary, linux/amd64, systemd install |

### Found while spec'ing

Push monitors already go DOWN with "No heartbeat in the time window" when no
push arrives within `interval + 1s buffer` (`server/model/monitor.js`, the push
branch of the check loop). The existing notification path fires from there, so
**host-down alerting is already built** — the agent just has to push regularly
and silence does the rest. No new alerting code for v1.

---

## Phase 1 — Ingest (backend)

### 1.1 `monitor_metric` table

```sql
-- monitor_metric
id            INTEGER PRIMARY KEY
monitor_id    INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE
time          DATETIME NOT NULL
payload       TEXT NOT NULL  -- JSON, schema below
```

Rules, same as the rest of the repo: knex methods, no native SQL. Index on
`(monitor_id, time)`. No FK games: cascade delete is correct here, unlike
`source_group_monitor_id` — metrics for a deleted monitor are meaningless.

Migration: `db/knex_migrations/2026-10-0X-0000-monitor-metric.js`
(validate filename date at write time against existing migrations).

### 1.2 Payload schema (versioned)

```json
{
    "v": 1,
    "sampledAt": "2026-10-12T09:15:00.123Z",
    "host": { "hostname": "client-a-db-01", "os": "linux", "uptime": 864001 },
    "cpu": { "percent": 23.5, "cores": 8, "perCore": [12.1, 88.4, ...],
             "counters": { "total": 103000, "idle": 92905, "perCore": [ { "total": 51500, "idle": 46452 }, ... ] } },
    "mem": { "total": 33554432, "used": 12582912, "percent": 37.5 },
    "disk": [ { "mount": "/", "total": 100, "used": 42, "percent": 42.0 } ],
    "gpu": { "available": false },
    "docker": [
        { "name": "api", "image": "api:1.4.2", "state": "running", "health": "healthy", "ports": [ "8080:80" ], "uptime": 86400 }
    ],
    "dockerError": "no docker access (...)", // only when collection failed
    "updates": { "total": 70, "security": 8 }, // absent when unknown, never zero-filled
    "agent": { "version": "1.5.0", "uptime": 86400, "samplesDropped": 2,
               "failedPushes": 0, "collectorErrors": { "gpu": 1 } },
    "load": { "avg1": 0.42, "avg5": 0.51, "avg15": 0.60 },
    "net": [ { "iface": "eth0", "rxBytes": 123456789, "txBytes": 9876543 } ],
    "diskIo": [ { "device": "sda", "readBytes": 1234567890, "writeBytes": 987654321 } ]
}
```

Notes:
- Units are documented once, here: bytes for memory/disk totals, percent 0–100,
  uptime seconds, USER_HZ ticks for CPU counters. The agent and the board must
  never disagree about units.
- `gpu.available: false` is explicit, never absent: "no GPU" and "collector
  broken" must be distinguishable or you will chase ghosts.
- `dockerError` is present only when collection failed, so the board can say
  "unavailable" instead of silently showing "none" for a blind agent.
- `cpu.perCore` is one percentage per logical CPU; `temp` fields are omitted
  when zero because zero means "no sensor", not a temperature.
- `cpu.counters` is the raw cumulative snapshot the server derives percentages
  from: `total` excludes guest (already inside user/nice), `idle` includes
  iowait. `percent`/`perCore` travel alongside as a compat fallback for old
  backends; new servers overwrite them with windowed derivations and ignore
  the agent's numbers whenever counters are present.
- `sampledAt` is when the agent took the sample (RFC3339, UTC). The server
  validates it (not more than 5 minutes in the future, not older than
  retention) and falls back to receive time otherwise — the server stays the
  clock authority. Used so a buffered agent's backfilled samples carry their
  real times: history stays honest about when things happened. The heartbeat
  always uses receive time.
- `updates` counts pending OS updates: totals only, never a package inventory.
  Absent means unknown (unsupported distro, failed check) and the board shows
  nothing; present with `total: 0` means fully updated. `security` appears
  only when the platform exposes severity — total-only platforms report no
  security field rather than a fabricated zero.
- `agent` is the agent's self-report, modelled on Telegraf's internal metrics
  input: `version` and `uptime` (drift and restart/crash-loop detection),
  plus counters since process start — `samplesDropped`, `failedPushes`,
  per-collector `collectorErrors` (only nonzero entries are sent) and
  `lastError`, which clears on the next successful push. Counts describe
  "has had trouble since start", not necessarily "failing now". Old agents
  omit the block, old servers ignore it. `docker` collector errors also
  travel as `dockerError`; the board renders those in one place only.
- `load` is the 1/5/15-minute load average, a gauge sent as-is.
- `net` and `diskIo` are raw cumulative byte counters, loopback and
  partitions excluded: the server derives per-second rates between
  consecutive pushes, same contract as CPU. Rates are attached to the live
  sample only as `netRate`/`diskIoRate` (with `windowSeconds`); archived rows
  keep the raw counters. A window longer than 5 minutes (restart, outage)
  yields no rate, never an average over a gap. When summing network
  throughput the server excludes virtual interfaces (`veth`, `docker`,
  `br-`, `virbr`, `vnet`, `tap`, `tun`, `wg`) so container traffic is not
  double counted; if a host has only virtual interfaces, all are summed.
- `container.uptime` is seconds since start, 0 when unknown.
- Disk is an array (root plus any data mounts); the agent sends every local
  mount it can read, the board shows the fullest first.
- `docker` is an empty array when Docker is absent, not null, for the same reason.
- `v: 1` so a future agent can add fields without breaking old readers. Unknown
  fields are ignored, never rejected.

### 1.3 Extend `/api/push/:pushToken`

Accept an optional JSON body alongside the existing query params:

```json
{ "status": "up", "ping": 12, "msg": "OK", "metrics": { ... } }
```

- Fully backwards compatible: query-param pushes behave exactly as today, and a
  body without `metrics` is today's request.
- `metrics` is validated for shape (object, under 64KB). When the agent sends
  raw CPU counters, the server derives `cpu.percent`/`perCore` from consecutive
  snapshots — short-window for live/latest, long-window for archived rows —
  and stores the derived numbers alongside the raw snapshots. Percent-only
  payloads from old agents pass through untouched. No thresholds; a failed
  derivation keeps the agent's values, never drops the sample.
- A push carrying metrics still counts as a heartbeat for the down-timeout, so
  one request keeps both "host up" and "here are the numbers" alive.
- Oversized or malformed `metrics` → 400, but the heartbeat itself is still
  recorded. A broken collector must never read as a dead host.

### 1.4 Retention

- Legacy pushes retain every sample for **30 days**. Opt-in live telemetry
  retains one snapshot per monitor per **30 seconds**, not every 1Hz sample.
- Hourly rollups (**min/max/average per metric**, plus the number of raw
  readings folded in) are kept for **two years** in `monitor_metric_hourly`.
  The rollup job runs hourly, folds only complete hours, and upserts on
  `(monitor_id, time)` so re-runs and crash recovery are idempotent; the last
  two complete hours are re-rolled each run so late/backfilled samples land.
  A first run backfills everything still in raw retention, chunked.
- Prune runs with the existing background-job pattern; the rollup job runs
  hourly at :12, before the daily raw prune at 04:27, so no hour is ever
  deleted before it has been folded.
- Ten live agents generate ~864k history rows/month at 30-second resolution,
  versus ~25.9 million full payloads if every 1Hz sample were persisted.

---

## Phase 2 — Agent (Go)

Single static binary (`CGO_ENABLED=0`), linux/amd64. No runtime dependencies.

### Collectors

| Source | What | Notes |
|---|---|---|
| `/proc/stat` cumulative counters | raw snapshots + compat percent/cores | server derives windowed utilization; agent percent is old-backend fallback only |
| `gopsutil/mem` | total/used/percent | bytes, per the schema |
| `gopsutil/disk` | per-mount total/used/percent | every local mount it can read |
| `gopsutil/disk` I/O | whole-disk cumulative byte counters | partitions filtered out; raw counters, server derives rates |
| `gopsutil/net` | per-interface cumulative byte counters | loopback excluded; server derives rates and excludes virtual interfaces when summing |
| `gopsutil/load` | load average 1/5/15 | gauge, sent as-is |
| `gopsutil/host` | hostname, os, uptime | |
| OS package managers | pending update counts (total, security) | read-only queries every 4h; apt-check exact, dnf security best-effort, rest total-only; failure → field absent, never fatal |
| Docker socket | containers: name, image, state, health, ports | list + inspect; **no stats streaming in v1** |
| `nvidia-smi` | util, mem, temp if present | exec + parse, best-effort; failure → `available: false`, never fatal |

### Behaviour

- Live mode defaults to **1-second pushes carrying raw CPU counters and
  1-second-fresh RAM**. Existing configs with an explicit 60-second interval
  retain it; change `interval_seconds` to 1 to opt in.
- Every push carries a fresh cumulative `/proc/stat` snapshot; the server
  derives utilization from consecutive snapshots (short-window for live,
  ~30s-window for archived rows), with no blocking sleep in the collection
  path. The agent's own percent fields remain as old-backend fallback only.
  RAM stays per-push fresh. Disk and temperatures refresh every 30s, GPU
  every 5s, Docker every 10s, pending-update counts every 4h in independent
  workers. Network and disk I/O counters and the load average ride every
  push (server derives rates for the live sample only). Docker event
  subscriptions and dedicated network/I/O history charts remain future
  work. Slow collector values are cached between refreshes.
- Delivery is disk-backed (agent 1.4+): samples wait in a bounded queue
  (`/var/lib/superboard/buffer`, cap `buffer_max_bytes`, default 32 MiB) until
  the server accepts them, oldest-first, so backend outages and agent
  restarts become late history instead of missing history. A backlog drains
  at ~20 pushes/s; the oldest samples are dropped when the cap is hit. When
  the directory cannot be used, the agent falls back to the in-memory
  newest-wins queue. One sender, bounded HTTP timeout, capped retry backoff,
  and one disk-buffer directory: never an ever-growing in-memory queue. No
  ±5-second jitter on a 1Hz cadence.
- The server archives backfilled samples at their real cadence: an archive
  row is due when either 30 seconds of wall clock or 30 seconds of *sample
  time* have passed since the last persist, so a drained backlog restores
  30s-resolution history rather than collapsing into one receive-time burst.
- The monitor's check interval must be at least 3× the agent interval (e.g.
  60s pushes against a 180s interval). Matching them flaps: a push landing
  seconds past the window reads as DOWN, then UP on arrival, every cycle.
- Push failure backs off and then retries the oldest pending sample from the
  buffer. A failed push
  is *not* reported as host-down locally — silence is the signal, and the
  server already turns silence into an alert.
- Config file (`/etc/superboard/config.json`, mode 0600): server URL + push
  token. Token rotation = regenerate server-side, replace one line, restart.
- `superboard install`: writes the systemd unit, daemon-reloads, enables and
  starts. `superboard uninstall` removes all three. Refuses to double-install.
- `superboard check`: one collection + one push to stdout, exit code tells you
  if the server accepted it. For provisioning and debugging without journald.

### Live transport (agent 1.2+)

- Live payloads add `sampleInterval`; POST `/api/push/:token?telemetry=1`
  enables the fast path. Legacy endpoints/payloads are unchanged.
- Healthy, non-inverted, non-maintenance hosts record a heartbeat at most every
  `min(30s, monitor.interval / 3)`, with a 1s minimum. First beats, explicit DOWN,
  recovery, maintenance and inverted monitors use the ordinary heartbeat path.
  Host timeout/check intervals are **not** changed automatically.
- Latest samples live in a bounded process-local cache (512 monitors); REST
  falls back to indexed durable history after restart/eviction. A restart can
  lose up to 30s of unarchived live samples. This is single-backend-process
  architecture, not a distributed cache.
- `/api/v1/events` streams bearer-authenticated heartbeat/metrics deltas. REST
  snapshots run on connect, reconnect, and coalesced configuration invalidation.
  No roster polling while connected; 30s fallback when disconnected. Token
  revocation, expiry, scope changes and account bans are checked every 15s.
- Freshness is separate from host reachability: live readings become stale
  after `max(5s, sampleInterval * 3)` even when the host timeout is 180s.
- Reverse proxies must disable SSE buffering and allow idle stream connections
  beyond 45s. The server sends 15s keepalives and `X-Accel-Buffering: no`.

### Explicitly out of v1

Per-container CPU/mem (stats streaming), threshold evaluation client-side,
log shipping, anything that is not "collect these things and POST them."
Agent 1.3 added pending-update counts to the list (read-only, counts only);
see the ranked backlog in [IMPROVEMENT-ROADMAP.md](IMPROVEMENT-ROADMAP.md)
for what is deliberately deferred and why.

---

## Phase 3 — Read API

Token-authed (bearer, same as the dashboard), alongside the existing v1 routers.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/monitors/:id/metrics/latest` | read | Most recent sample, or 404 when none yet |
| `GET` | `/api/v1/monitors/:id/metrics?hours=24` | read | Windowed history, newest first, capped (suggest 1000 rows) |

- `hours` defaults to 24, max 168 (7d). Older than retention → whatever survives.
- Response shape is the stored payload plus `time`; the server does not reshape it.
- CORS: same `api-cors.js` middleware as the rest of v1, so the browser board can read it.

### As built

- `latest` orders by `time DESC, id DESC`, not `id DESC`: insertion order and
  time order diverge when samples arrive late, and the first version returned a
  stale row because of it. History orders the same way.
- Unreadable rows are skipped rather than failing the window: one corrupt
  payload degrades one sample, not the whole response.
- History is hard-capped at 1000 rows with a `capped` flag, independent of the
  `hours` window.
- `monitorToJSON` now also returns `weight` and `parent`. The board needs them
  to reproduce the operator's intended order, and they are harmless layout
  metadata. This is the only change to an existing endpoint in the phase.

---

## Phase 4 — Superboard page

A route in the dashboard app (auth-only via the existing token gate), visually
distinct from the dense table: this is the NOC wall, not the operator desk.

### Layout

- One card per server (one card per monitor with metrics; group monitors excluded).
- Each compact card: hostname, host/workload status, pending-update line
  (`No updates` green, `Updates: N` yellow/red at 50+, `Security Updates: N`
  dark red; nothing when unknown), CPU total + intensity-based
  per-core squares, RAM / disk / GPU / VRAM bars, and a container name/state/
  uptime list. Healthy readings stay neutral; real issues stand out. Exited
  containers are not failures without an expected-running policy.
- Bars are width + number, never colour alone — same rule as everywhere else.
- Fullscreen-friendly: no header chrome in kiosk mode (`?kiosk=1` hides the nav),
  large type, high contrast, works at Full HD and 4K@150%.

### Auto-pagination

- Pages of N cards (fit to viewport, default 6–8), rotating every **5s**
  (configurable via query param, e.g. `?rotate=5`).
- Rotation pauses on any interaction (click/keypress) and resumes after 30s idle,
  so touching it to investigate does not fight you.
- With few enough servers to fit, no rotation happens at all — no empty pages.
- A progress indicator shows position ("2 / 3") so the rotation is legible, not
  disorienting.

### Editing (mostly in the admin panel)

- Pairing lives in the monitor edit flow: generate/rotate the push token, set
  the expected interval, link the monitor to its client group.
- The board's one control is rename: right-click a card for a custom menu,
  Rename edits the monitor's display name (card titles prefer it over the
  agent-reported hostname, which stays read-only). Rotation pauses while the
  menu or dialog is open. Saving PATCHes the monitor; the server broadcasts
  an invalidate and every board resnapshots. Needs a write-scoped token —
  a read-only wall shows the server's refusal instead of failing silently.
- What "editable" means concretely: which servers appear (any monitor with a
  recent metrics sample), card order (follow group weight, then name), and the
  rotate interval. All three are board settings, not per-card controls.

### As built

- Routes live in the dashboard app: `/superboard` (with chrome) and
  `/superboard/kiosk` (no chrome, fixed viewport, no scrollbar). A ~40-line
  path router in `src/lib/router.ts`; no routing dependency.
- Board scopes: appending a monitor-group segment narrows the board to that
  group's children — `/superboard/kiosk/work` for the work wall,
  `/superboard/personal` for the desk, comma-separated for several
  (`/superboard/kiosk/work,personal`). Matching is by group slug
  (lowercased, `Aiel Qorgan` → `aiel-qorgan`) or case-insensitive exact
  name; only `type: "group"` monitors match, and unknown scopes match
  nothing rather than everything. The unfiltered URLs show the whole fleet.
  Live arrivals respect the scope; the wall header names it.
  Prerequisite is ordinary grouping: link each monitor to its group in the
  admin panel. Do not name a group `kiosk` (the desk URL would lose to the
  kiosk route).
- Discovery is the 404: the board lists monitors, skips `type: "group"`, and
  calls `metrics/latest` for the rest. A 404 means "not a server" and is
  dropped. Zero configuration, and a server that stops pushing ages out on its
  own.
- Card order: parent group `weight`, then the monitor's own `weight`, then
  name. Name is the tie-breaker so the board never reshuffles between
  refreshes.
- Page size is measured, not hard-coded: the board computes columns × rows from
   its own box against a 340×420 minimum and actual card heights, so Full HD
  and 4K@150% both fill sensibly. `?perPage=N` overrides; `?rotate=SECONDS`
  sets the rotation interval (default 5, clamped 1–300).
- Rotation pauses on any pointer, key or touch interaction and resumes after
  30s idle. It also pauses while the tab is hidden. With everything fitting on
  one page there is no rotation at all.
- Snapshots run on SSE connect/reconnect; streaming changes are applied without
  whole-roster reloads. A local 1s clock ages freshness even if the only host
  stops sending. Stale cards retain readable numbers with an amber warning.
- Default page capacity is at least **10 hosts**, even when a tall GPU card
  makes the viewport measurement estimate only one row. Fleets up to ten stay
  together; narrow screens scroll rather than auto-rotating a small fleet.
  Explicit `perPage` query overrides remain supported for custom kiosks.

### Compact container tiles

- Container view uses three columns and three visible rows (nine name-only
  tiles); container uptime is omitted. Full names, state/health and image are
  available in tooltips. Symbols and accessible labels supplement color:
  muted green = running/healthy (or running without a reported health check),
  black = exited/removed with **unknown stop intent**, red = restarting/dead/
  running-unhealthy, yellow = starting/created/paused/unknown transitions.
- Nine or fewer containers remain static. Larger lists loop vertically and
  seamlessly at roughly four seconds per row, without manual scrolling or
  scrollbars on either axis. Hover/focus pauses motion; reduced-motion users
  get a static view. Duplicate loop tiles are hidden from assistive technology.
- Up to six failing containers are pinned, reserving at least one rotating row.
  When more than six fail, remaining failures lead the rotating list; no
  containers are dropped. Docker collection errors remain explicit.
- Current agent payloads do not establish manual stop intent or exit codes.
  Do not infer a crash from `exited`, or label a stop as definitely manual.

### Host updates (agent 1.3+)

- Read-only OS package-manager checks every 4 hours, reporting counts only:
  `updates: { total, security? }`. No package inventory on the wire or the
  board, and no automatic installation, service restart, or reboot. Checks
  read existing package lists (`apt-get -s`, `check-update` query mode) and
  never fetch or modify anything.
- Card line, counts only: `No updates` green when total is 0; `Updates: N`
  yellow below 50, red at 50 or more; `Security Updates: N` dark red whenever
  any are reported, taking precedence over the total. Absent field means
  unknown (unsupported distro, failed check) and renders nothing — a blind
  agent never reads as fully updated.
- Severity comes from OS advisory metadata only: Ubuntu update-notifier
  reports exact security counts, dnf filters `--security` best-effort, and
  total-only platforms (pacman, apk, plain apt simulation) report no
  security field rather than a fabricated zero. Unsupported OSes, stale
  results, permissions failures, or failed refreshes stay unknown, never
  `No updates`.
- A pending-reboot indicator is still future work: long uptime alone does
  not prove that a server is unpatched.

### Server load history

- Select a server name (↗) to open the keyboard-accessible history dialog.
  Escape closes it; kiosk rotation pauses while it is open. Containers remain
  overflow-hidden with no scrollbars.
- Ranges: 10m, 1h, 6h, 24h, 7d, 30d, 1y. Only the open dialog refreshes
  history every 30s; live board updates continue independently. Range changes
  abort old reads.
- `/api/v1/monitors/:id/metrics/summary?hours=1` extracts compact CPU/RAM/GPU/
  VRAM scalars, at most 240 chart buckets and 50,000 source rows. Windows up to
  7 days read raw snapshots; longer windows up to 17520 hours (2 years) read
  the hourly rollups, where percentiles describe hourly averages while **peak
  stays the true maximum** from the stored extremes and `samples` reports the
  raw readings rolled up. The response's `basis` field says which tier
  answered. If capped, the UI explicitly warns that statistics describe a
  truncated window.
- p90/p95/p99 use nearest-rank over **archived readings**, not downsampled chart
  averages or raw 1Hz live samples. Missing GPU or invalid values are excluded,
  not interpreted as zero. GPU/VRAM charts describe the first device. Charts
  show bucket averages; gaps are disconnected, and coverage starts at the
  first available archived sample.
- Card `Peak 10m` is the highest observed **total CPU percentage** in a rolling
  10-minute window, not the currently busiest core. A bounded, monotonic live
  window adds no per-push history writes. After restart it warms from archived
  snapshots, so unarchived spikes before restart cannot be reconstructed.
  `cpuPeak10m: {percent, at} | null` is additive REST/SSE sample metadata; agent
  payloads and existing metric rows are unchanged. No agent upgrade is needed.

---

## Phase 5 — Metric threshold alerts

Server-side, evaluated at ingest from the values the server already derives
(CPU) or receives (RAM, disk). Alert-only: no monitor status flips, no
heartbeat rows — the existing host-down path stays the only thing that can
take a monitor DOWN.

### Configuration

- Three per-monitor integer fields, 1–100, empty = disabled:
  `metricCpuThreshold`, `metricRamThreshold`, `metricDiskThreshold`
  (columns `metric_cpu_threshold`, `metric_ram_threshold`,
  `metric_disk_threshold`). Set through the monitor edit form (Advanced →
  Metric thresholds) or the REST PATCH allowlist. Group-level defaults are
  deliberately not in v1.
- Disk compares the fullest reported mount; the alert names it.

### Semantics (locked)

- Alert when the value stays at or above the threshold continuously for
  **60 seconds** (debounce). A one-second spike never pages anyone.
- Recovery when the value falls to **threshold − 5 points** or below
  (hysteresis), so values hovering at the boundary do not flap.
- While still breached, the alert repeats at most every **30 minutes**
  (cooldown). A recovery message is sent only when an alert for that breach
  episode actually went out; suppressed episodes stay silent.
- Evaluation uses receive time, not `sampledAt`: a backfilled backlog
  arriving compressed must not replay old alert timelines; outages are
  already covered by the host-down path.
- Maintenance windows suppress delivery (state still tracks reality), like
  they suppress heartbeat notifications.
- Notification text: `[name] [⚠️ Metric] CPU 94.2% ≥ threshold 90%` and
  `[name] [✅ Metric] CPU recovered: 72.1% (threshold 90%)`, sent through
  the monitor's linked notification list. Templates receive a
  `heartbeatJSON` marker (`metricAlert: true`) so they can label the event.
- State is in-memory per monitor (bounded, 512): an agent or backend restart
  may re-send one alert after the debounce. Thresholds are for live
  conditions; history keeps the evidence.

### Where evaluation runs

`server/metric-alerts.js`, called from the push route after a metrics store
succeeds, fire-and-forget (never blocks or fails a push), and only when at
least one threshold is configured. It reads the latest cached sample — the
server-derived values — so it never re-derives CPU windows itself.

### As built

- Storage is three nullable integer columns, not a JSON blob: simpler to
  validate (`monitor-service.normaliseMonitorPayload` clamps to 1–100,
  anything else stores NULL = disabled), simpler to query, and the edit form
  gets three plain number inputs.
- Constants live in the module: `DEBOUNCE_MS` 60s, `COOLDOWN_MS` 30min,
  `HYSTERESIS` 5 points. Not configurable in v1.
- Hysteresis band (threshold−5 < value < threshold) is silent: the episode
  stays open but no repeat fires, because a repeat would print
  "88% ≥ 90%". Recovery is only declared at or below threshold−5.
- Missing readings (an agent that stops sending one metric) never fake a
  recovery; the episode is left untouched.
- A recovery message is sent only when an alert for that episode actually
  went out; fully suppressed episodes stay silent. Maintenance windows
  suppress delivery, not tracking.
- Telegram templates get `heartbeatJSON.metricAlert = true` and render
  status "⚠️ Metric" instead of the misleading "⚠️ Test" fallback.
- State map is bounded at 512 monitors, evicting oldest-first like the CPU
  peak tracker.

---

## Sequencing and risks

1. Migration + ingest extension (shippable, testable with curl)
2. Go agent (testable against the above with `superboard check`)
3. Read API
4. Superboard page

| Risk | Mitigation |
|---|---|
| DB grows unbounded | Prune job ships in the same commit as the table |
| Agent version skews payload shape | `v: 1` envelope; server ignores unknown fields |
| A broken collector reads as a dead host | Malformed metrics 400s but the heartbeat is still recorded |
| Push token leaks from a client box | 0600 config; rotation is one server-side regenerate + one line |
| Plain HTTP on the wire | Document TLS requirement; the agent refuses plain HTTP unless explicitly allowed |
| nvidia-smi parsing breaks on a new driver | Best-effort by contract; failure yields `available: false`, never a crash |
| Board overwhelms at 10+ clients | Auto-pagination is the design, not a fallback; verify at 4K before calling it done |

## Resolved

| Question | Decision |
|---|---|
| Retention | **30 days**, 30-second snapshots for live telemetry; every legacy sample retained |
| Non-systemd boxes | **cron `@reboot` fallback** with a logged warning. systemd when present; never a silent half-install |
| Kiosk param vs route | **Dedicated route.** `/superboard` (with nav) and `/superboard/kiosk` (chrome-free, memorable wall URL) |
