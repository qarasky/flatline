# Office deployment

Public origin: `https://uptime.mediaboost.kz`, existing Cloudflare Tunnel to
`http://localhost:3001`.

**Current (since 2026-10-13): the Rust backend.** One container
(`artchsh/flatline-rust:office-live`) serves the API and the web app —
operator dashboard and public status pages — on one origin. Compose:
`/home/office/flatline/compose.rust.yaml` (project `flatline-rust`); data:
`data-rust/`. The Node stack is stopped and kept for rollback; see the
cutover record further down.

Historical: the Node deployment ran as a standalone
`compose.production.yaml` deployed as `/home/office/flatline/compose.yaml`.
Uses the system (rootful) Docker daemon via `sudo docker`.
Moved from the `office` user's rootless daemon on 2026-10-11; the old
rootless daemon is no longer used for this stack.

Build the Node image for `linux/amd64` on the build machine, then
transfer/load it into office's system daemon (`sudo docker load ...`). All
`docker` commands on office run as root:

```sh
docker build --platform linux/amd64 -f docker/dockerfile --target release -t artchsh/flatline:office-live .
```

The Rust image builds on the office itself from a synced source tree:

```sh
cd /home/office/flatline-src
sudo docker build --platform linux/amd64 -f docker/rust.dockerfile -t artchsh/flatline-rust:office-live .
```

Stage on loopback port 3101. Do not replace the original Kuma data directory.
Use SQLite's backup API for a consistent copy of a running database. Keep all
DB files, backups, credentials, tunnel tokens and agent configs out of Git.
Before public access, rotate operator passwords, revoke development API keys,
and disable unwanted accounts. Agent push tokens are separate credentials.

For staging, detach notification links in the *copy* (notification `active=0`
alone does not mute upstream monitor delivery). Restore links and original
notification activation only after stopping other active monitoring backends.

Cutover requires stopping `uptime-kuma` to release port 3001, then setting
`FLATLINE_PORT=3001` in `.env` and recreating the stack. The original
container/image/data remain available for rollback. Agent configs must also
be redirected to office. The system Docker daemon starts at boot via systemd;
user linger for the `office` account is no longer required for this stack.

Rollback (office, as root):

```sh
cd /home/office/flatline
sudo docker compose stop
sudo docker start uptime-kuma
```

The stopped `uptime-kuma` container must exist in the system daemon for the
last line to work — import it there first if it still lives only in the old
rootless daemon.

This restores the original public application without modifying either DB.
Restore saved pre-cutover agent configs separately if returning to the Mac
Flatline backend. Stop one monitoring backend before enabling another to avoid
duplicate alerts. Do not start the old Mac backend after production cutover
unless its notification links have first been disabled.

## Performance follow-up release — 2026-10-14

Image rebuilt on the office from the synced tree
(`/home/office/flatline-src`, master `4eb22da2`) and the stack recreated
(`docker compose -f compose.rust.yaml up -d`), image
`artchsh/flatline-rust:office-live` → `07e4e97b609d`. What shipped: the seven
`PERFORMANCE-STABILITY-FOLLOWUP.md` fixes (rollup/prune coordination, bounded
rollup work selection, Redis/MySQL deadlines, notification retries + shutdown
drain, uptime off the publication path, Docker collection bounds) plus agent
**1.6.0/1.6.1**. A consistent DB backup was taken first
(`backups/pre-1.6.0-20261014-003310.db`, `integrity_check: ok`).

Verified after the switch: container healthy, migrations 0007/0008 applied,
heartbeat retention ran at startup (222 rows), API 36/36 monitors up with live
uptime windows, dashboard bundle serving, `/agent/version` → 1.6.1 with
matching checksums, public origin 200 through the tunnel, and the office agent
updated to 1.6.1 pushing normally.

Open item: the office GPU is unusable until the host is rebooted —
`nvidia-smi` reports `Failed to initialize NVML: Driver/library version
mismatch` (NVML 595.99 vs the running driver), which failed on every 5s poll
before 1.6.1. The agent now counts it as one failure episode, backs the poll
off to one attempt per five minutes and logs the reason once; the card shows
a single `gpu` collector error until the host is rebooted. No GPU data is
lost — the office's emulator workloads do not use it.

## Move to rootful Docker — 2026-10-11

- Stack moved from the `office` user's rootless daemon to the system
  (rootful) daemon. Compose path unchanged (`/home/office/flatline`);
  manage it with `sudo docker compose ...` as root.
- The host superboard agent (root systemd service) now reads containers
  from the standard root socket (`/var/run/docker.sock`) directly instead
  of falling through to a rootless socket.
- User linger for the `office` account is no longer needed for this stack.
- Data under `/home/office/flatline/data` is now written by rootful
  containers: expect root-owned files there and manage/back up that
  directory as root.

## Cutover to the Rust backend — 2026-10-13

**Deployed.** The public origin is served by the Rust backend
(`artchsh/flatline-rust:office-live`, one container, one origin — API and
web app). The Node stack (gateway, dashboard, status-site, flatline) is
**stopped but kept** for rollback; its `./data` is untouched.

- Compose: `/home/office/flatline/compose.rust.yaml` (project
  `flatline-rust`, port 3001). The old `compose.yaml` is the rollback
  stack.
- Data: `/home/office/flatline/data-rust/flatline.db` (imported from a
  consistent copy of the pre-cutover database; verified by
  `docker/parity-contract.py`, 115/115).
- **Admin token** (dashboard sign-in: use it as the password):
  `data-rust/initial-token.txt` (0600, root-owned; `sudo cat`).
- Rollback: `sudo docker compose -f compose.rust.yaml down && sudo docker
  compose up -d` — the Node stack and its original database return.
- The importer run surfaced one cutover-blocking bug, fixed and verified
  in staging: the old schema stores accepted status codes in
  `accepted_statuscodes_json`; the importer read the wrong name and
  defaulted every monitor to 200-299, which would have flipped four
  monitors that accept 4xx to DOWN.
- Agents are unchanged (same origin, same tokens); push traffic and
  check heartbeats verified fresh after the switch. The three ping
  monitors run through the system `ping` binary in the image.
- The previously pending Node-side rollout below (v2 consolidation,
  counters, threshold alerts, agent 1.5) is superseded by the Rust
  backend for the backend half; **agent 1.5.0 is deployed on the five
  client hosts** (2026-10-13), with office and the personal hosts still
  on 1.2.0.

### Dashboard grouping — 2026-10-13

The monitor tree was reorganised on request and now nests: two root groups,
`personal` (personal-server 44, raspberrypi 45) and `work` (everything
else), with the seven client/site subgroups (`bes.media`,
`nationalbusiness.kz`, `MEKS`, `nofake`, `jasalash`, `qumash.kz`,
`Aiel Qorgan`) nested under `work` and `office`/`cmn` directly on it. The
dashboard renders the tree recursively (indented, collapsible, subtree
counts). Status pages are unaffected — they use their own group tables
(`status_page_groups`), not the monitor tree.

The same release added: group monitors are **checked** again (the Node
`GroupMonitorType` semantics: worst-of-children, paused ignored, empty =
pending, down names the children — ported into the Rust engine), ping rows
show their ICMP hostname instead of a junk `https://` url, and right-click
→ Rename works on monitor-list rows as well as Superboard cards.

### Group management, alert format, failure clearing — 2026-10-13 (second release)

Operator feedback: "no obvious way to manage groups", alerts should name
the group path/type/target, and push failures needed a way to clear.

- **Group management in the dashboard.** A `New group` button in the
  header; every group header and monitor row carries a `⋯` menu (right-
  click works too). Groups: New subgroup / Rename group / Move group /
  Delete group (delete offers "children move up" vs "delete everything").
  Monitors: Rename / Move to group. The form's raw parent-id input became
  a Group picker over real group paths ("work / MEKS"). The API needed no
  changes — create/PATCH/DELETE already validate parents and cycles; the
  "children move up" mode re-parents before deleting so nothing is
  orphaned.
- **Telegram alert shape** (operator-specified):
  `[🔴 DOWN] [work / MEKS] [modernization-meks]` / `[push]
  [modernization-meks]` / `[No heartbeat in the time window]` /
  `[CPU 12% · RAM 43% · Disk / 71% · Load 0.42]`. The last line exists for
  push monitors only (newest archived sample); metric alerts use the same
  two-line shape with a `[⚠️ METRIC]`/`[✅ METRIC]` tag. Group paths come
  from the monitor tree; ungrouped monitors read `[Ungrouped]`.
- **Clear push failures.** `agent.failedPushes` is the agent's cumulative
  counter; the server now stores `monitors.push_failures_ack` (migration
  0006) and `POST /api/v1/monitors/{id}/push-failures/clear` acknowledges
  the current value. The board shows `failedPushes - ack` and the
  Superboard card menu offers "Clear push failures (N)" only while the
  counter is ahead. Ingest drops the ack whenever a newest sample reports a
  lower counter, so an agent restart can never leave new failures hidden.

### Provisioning surfaces for LLM agents — 2026-10-13 (third release)

Operator request: one tokenized URL the CTO can point Claude at, which both
documents and enables adding a push server, plus one-liners to install and
update the agent.

- **Runbook**: `GET /add-push-server.md?token=<key>` (also accepts
  `Authorization: Bearer`). Served from the repo-root `add-push-server.md`,
  embedded in the binary and rendered with the origin, the token and the
  agent version substituted, so every command in it is copy-paste ready.
  Covers push/http/ping monitors, groups, notifications, pause/delete,
  field reference and troubleshooting.
- **`/llms.txt`** — pointer file for LLM crawlers, linking the tokenized
  runbook.
- **Installer**: `GET /agent/install.sh?token=<key>` — pre-credentialed
  script. Fresh install needs `--server <origin> --token <push token>`;
  `--update` replaces the binary and restarts, keeping config and push
  token (previous binary kept as `superboard.bak`).
- **Binaries**: `/agent/superboard-linux-amd64` and `-arm64`, checksums at
  `/agent/sha256sums`, metadata at `/agent/version`. Built in the image by
  a Go stage in `docker/rust.dockerfile` (`VERSION` file beside them).
- Everything is gated by an ordinary API key. The one in use is named
  `llm-provisioning` (mint/disable in the dashboard's Agents panel); the
  token and its full URL live on the office host at
  `provisioning-token.txt` (root 0600), not in Git. Rotation: disable the
  key in the panel, mint a replacement, update that file and the shared
  URL.
- `FLATLINE_PUBLIC_URL=https://uptime.mediaboost.kz` in the office `.env`
  (passed through by `compose.rust.yaml`) so rendered links are absolute;
  without it the request's Host header is used.

Verified live 2026-10-13: all endpoints serve correctly and answer 401
without a token; the served binary's sha256 matches `sha256sums`; the
office agent was updated 1.2.0 → 1.5.0 → 1.5.1 entirely through the
script; a fresh install in a throwaway Debian container came up and pushed
telemetry within seconds. Agent 1.5.1 (this image) fixes the cron fallback
on hosts with no existing crontab — the fleet's systemd hosts are
unaffected.

### Superseded: pending Node rollout — 2026-10-12

Kept for reference; not deployed (the Rust cutover replaced it).

- v2 consolidation: the single image serves the API and the web app. On
  deploy, load the new image, update `compose.yaml` (one service, no
  gateway), then `sudo docker compose up -d --remove-orphans` — the old
  `dashboard`, `status-site` and `gateway` containers are retired. The
  Cloudflare Tunnel already points at `localhost:3001`, which the single
  service now publishes.

- Backend: raw CPU counters with server-side utilization derivation (live
  short-window, ~30s means in history), agent pending-update counts ingest,
  Phase 5 metric threshold alerts (CPU/RAM/disk, per monitor, 60s
  debounce / 30min cooldown / hysteresis / recovery), and two-tier history
  (hourly min/max/avg rollups for two years; summary switches tiers by
  window).
- Dashboard: pending-update line on cards, group-scoped boards
  (`/superboard/kiosk/<group>`), right-click rename, agent version + warning
  lines, threshold fields in the monitor edit form (Advanced), and 30d/1y
  history ranges.
- Agent **1.5.0**: sends raw counters, update counts, a self-report block
  (version, uptime, dropped samples, failed pushes, collector errors), load
  average, network and disk I/O counters, per-container one-shot CPU/memory
  stats, SMART disk health (every 6h), plus a disk-backed send buffer
  (default `/var/lib/superboard/buffer`, 32 MiB cap)
  with `sampledAt` backfill; rebuild
  (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o superboard .`) and
  restart on office and all client hosts.
- Order: backend → dashboard → agents. Both directions are compatible; the
  new numbers (steady CPU history, update counts) appear only after the
  matching side ships.
- Deploy with the usual flow: build `linux/amd64` images, `sudo docker load`,
  `sudo docker compose up -d` in `/home/office/flatline`. Back up the DB first.

## Cutover record — 2026-10-09 (rootless era, kept for history)

- Office stack is deployed in `/home/office/flatline`, gateway on loopback 3001.
- Original `uptime-kuma` is stopped, not removed. Original data is unchanged.
  Its consistent backup is under `/home/office/flatline-backups/` (integrity OK).
- The Mac Flatline backend was stopped. Agents 43/44/45 now push over HTTPS
  to the public origin; all three were verified through the Cloudflare SSE
  stream. Office's agent binary was moved to `/usr/local/bin/superboard`.
- Production `skyler` password was rotated; 18 development API keys revoked.
  New credentials are stored locally in Git/Docker-ignored
  `private/office-production-login.txt` (0600), not in this document.
- Original 25 notification links were restored after cutover. One migration
  test was accepted by Telegram for MBG Alerts; recipient confirmation remains
  required. Agent monitors have no notification links: select their destination
  before claiming they have working host-down Telegram alerts.
- Public dashboard, `/status/clients`, logo, API authentication, and SSE checked.
- Dependency audit: 12 inherited production advisories (6 moderate, 4 high,
  2 critical). Review and remediate in a separate tested hardening pass; do not
  blindly run `npm audit fix --force` on the production stack.
