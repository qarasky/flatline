# Client agents

Provisioned using the existing credential-store SSH launchers in `client-cli/`,
following `client-cli/how-to-use.md`. No SSH passwords were requested, passed
via arguments/environment, or captured. The folder and ignore rules are unchanged.

| Launcher / monitor name | Monitor ID | Dashboard group |
|---|---:|---|
| aiel-qorgan | 46 | Aiel Qorgan |
| cmn | 47 | Ungrouped |
| modernization-meks | 48 | MEKS |
| national-business | 49 | nationalbusiness.kz |
| zhasalash | 50 | jasalash |

## Incident — 2026-10-12: provider blip paged as host-down

Four client hosts (aiel-qorgan 46, cmn 47, modernization-meks 48,
national-business 49) all sit on the same provider (AS48716 PS Internet
Company, `2a00:5da0::/32`). Their network path to Cloudflare broke twice —
~3 minutes around 10:31 UTC and ~8 minutes around 20:00 UTC. Agent logs show
every push failing with `context deadline exceeded (Client.Timeout exceeded
while awaiting headers)`; the servers themselves were healthy. zhasalash (50,
AS203087) and the office host were unaffected, so the backend and tunnel were
fine throughout.

Because push monitors had `maxretries=0`, the first missed window (180s + 1s
buffer) declared DOWN instantly, and the parent groups amplified it ("Child
monitors down") — about ten Telegram messages per blip.

**Fix applied on the production DB (2026-10-12):** all push monitors now use
`maxretries=2, retry_interval=180`, so a missed heartbeat goes PENDING
(silent, yellow on the board) for two retry windows and only pages after
~9 minutes of silence. Both blips would have been silent; real outages still
alert. Rollback values: `maxretries=0` and `retry_interval` 60 (monitor 43)
or 180 (44–50). The deployed agent has no send buffer yet, so these blips
leave telemetry gaps; agent 1.5's disk buffer closes that once deployed.

## Agent 1.5.0 rollout — 2026-10-13

**Deployed to all five client hosts** (aiel-qorgan 46, cmn 47,
modernization-meks 48, national-business 49, zhasalash 50), replacing
1.2.0 in place (`/usr/local/bin/superboard`, service restarted, config and
push tokens unchanged). Verified per host: `superboard version` = 1.5.0,
service active, `/var/lib/superboard/buffer` created (0700 root), and
server-side through the public API: raw CPU counters, load average, net and
disk I/O counters with server-derived `netRate`/`diskIoRate`, the agent
self-report block, pending-update counts and SMART health all flowing.

Still on 1.2.0: **office (43)** — needs Tailscale access to reach the host;
**personal-server (44)** and **raspberrypi (45)** — deferred by the
operator.

## Superseded rollout notes — 2026-10-12

Kept for reference.

- Agent **1.5.0** (raw CPU counters, server-side utilization derivation,
  pending-update counts, self-telemetry, disk-backed send buffer with
  `sampledAt` backfill, load average, network/disk I/O counters,
  per-container CPU/memory stats, SMART disk health) is committed
  but **not yet deployed to these hosts**.
  Order: backend + dashboard images first, then rebuild the agent binary and
  restart `superboard` on each box. The backend is backward compatible either
  way, but update counts and buffered backfill only appear after the agent
  upgrade. The agent creates `/var/lib/superboard/buffer` (0700) on first
  run; tune `buffer_dir` / `buffer_max_bytes` in the config if the default
  disk location is unsuitable.
- Configured `interval_seconds` remains 1 on all five hosts; 30-second archival
  and per-host group linking are unchanged.
- Metric threshold alerts are **server-side**: they activate with the backend
  deploy alone, no agent upgrade needed. Per-host thresholds are configured in
  the monitor edit form (Advanced → Metric alert thresholds).
- Hourly history rollups (two-year retention) are also server-side: the
  backend folds raw samples every hour and the dialog gains 30d/1y ranges.
  No agent change.

## Provisioning record — 2026-10-09

All five hosts are Linux x86_64. Agent 1.2.0 is installed persistently at
`/usr/local/bin/superboard`, enabled via root systemd service `superboard`.
The config is `/etc/superboard/config.json` (0600); its parent is 0700.
Push tokens are unique per monitor; the administrative API token is **not**
installed on any client host. Upload staging binaries were removed after install.

- Destination: `https://uptime.mediaboost.kz` with TLS verification enabled.
- CPU/RAM telemetry: 1 second; GPU: 5s; Docker: 10s; disk/temperatures: 30s.
- Host-down timeout: 180 seconds; existing default MBG Alerts assigned after
  successful ingestion. No deliberate host outage was induced to test delivery.
- All five reported Up with working Docker collection; three live SSE samples
  per new monitor were verified through the public endpoint.
- Website monitor `zhkhteam.kz` (51) added under MEKS at `https://zhkhteam.kz`,
  with 60-second checks/retries and existing MBG Alerts. It reported Up.
- Superboard card titles now use monitor names, preserving actual hostname
  in the title tooltip, so provider-generated numeric hostnames do not obscure
  these assigned names. The dashboard image was rebuilt/deployed; backend and
  client applications were not restarted for this presentation change.

Provisioning manifests/scripts with push credentials are held in Git/Docker-
ignored `private/client-agent-deployment/`, never in this document or `client-cli/`.

## Agent 1.5.1 — 2026-10-13

One fix: `superboard install`'s cron fallback treated `crontab -l` exiting 1
("no crontab for root") as fatal, so fresh installs on non-systemd hosts
failed. Found while testing the new `/agent/install.sh` flow in a clean
container; fixed in `install.go`, version bumped to 1.5.1.

Updates no longer need SSH uploads — the server now serves the binary and a
pre-credentialed script:

    curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update

Office (43) runs 1.5.1 (updated through that script). The five client hosts
stay on 1.5.0: the fix only affects non-systemd installs, and they can be
updated with the same one-liner whenever convenient.

## Agent 1.6.0 — 2026-10-14 (in the office image, not yet rolled out to hosts)

Two delivery/collection fixes, both from the performance follow-up review:

- a payload the server permanently refuses (HTTP 400/413) is quarantined
  (`buffer/quarantine/`, newest 20) and counted instead of blocking every
  healthy sample behind it; a credential/configuration answer (404/401/403)
  keeps the backlog and is logged at most once per five minutes;
- Docker collection runs under one 20s deadline on a 4-worker pool with
  context cancellation; a failed or over-budget pass keeps the previous
  container list, reports how old it is, and the payload carries `dockerAt`
  so the board can show "containers as of Xm ago".

Roll out per host with the same one-liner (the binary is built into the
office image):

    curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update

## Agent 1.6.1 — 2026-10-14

Counter semantics, after the board's warning lines climbed without anything
actually wrong:

- `failedPushes` is now "samples delivery lost" (quarantined rejects, failed
  pushes in the in-memory fallback). A failure that is retried and delivered
  only records `lastError` — the fleet's 36–201 counts came from backend
  restarts, tunnel blips and the 2026-10-12 provider outage, and made the
  amber line climb forever while no sample was lost. The counter resets on
  restart (this update) and now moves only when data is actually lost.
- `collectorErrors` counts failure *episodes* per collector instead of every
  failed attempt. The office host's NVML driver/library mismatch failed every
  five seconds (~17k counts/day) and pinned an amber warning on the card; it
  now counts once. The GPU poll also backs off to one attempt per five
  minutes while broken and logs the reason once instead of every tick.

Ships in the office image; per-host update is the usual one-liner:

    curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update

## Agent 1.6.0/1.6.1 rollout — 2026-10-14

All five client hosts (46–50) and the office host (43) run **1.6.1**, updated
in place through `/agent/install.sh --update` (config and push tokens kept,
services active, `superboard version` verified per host). Server-side check
of the whole fleet's self-report after the update: every agent reports
1.6.1, no `failedPushes`, no `samplesDropped`, and no collector errors —
the office's `gpu: 1` is the one real defect below.

Open item (office, 43): `nvidia-smi` fails with
`Failed to initialize NVML: Driver/library version mismatch` (NVML library
595.99 vs the running driver) — the card needs a reboot (or a driver
reload) to recover. Until then the agent reports `gpu.available=false`,
counts a single failure episode, retries the poll every five minutes, and
logs once: no board warning that climbs and no journal spam.
