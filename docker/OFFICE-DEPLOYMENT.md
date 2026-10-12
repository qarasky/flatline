# Office deployment

Public origin: `https://uptime.mediaboost.kz`, existing Cloudflare Tunnel to
`http://localhost:3001`. Gateway routes `/api/` and `/upload/` to the backend,
`/status/` and `/_next/` to the status site, and other paths to the dashboard.
SSE buffering is disabled. Only the gateway is published.

The standalone `compose.production.yaml` is deployed as
`/home/office/flatline/compose.yaml` with `docker/production-gateway.conf` copied
alongside it. Uses the system (rootful) Docker daemon via `sudo docker`.
Moved from the `office` user's rootless daemon on 2026-10-11; the old
rootless daemon is no longer used for this stack.

Build all images for `linux/amd64` on the build machine, then transfer/load
them into office's system daemon (`sudo docker load ...`). All `docker`
commands on office run as root:

```sh
docker build --platform linux/amd64 -f docker/dockerfile --target release -t artchsh/flatline:office-live .
docker build --platform linux/amd64 -f docker/dashboard.dockerfile -t artchsh/flatline-dashboard:office-live .
docker build --platform linux/amd64 -f docker/status-site.dockerfile --build-arg NEXT_PUBLIC_FLATLINE_URL=https://uptime.mediaboost.kz -t artchsh/flatline-status:office-live .
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
`FLATLINE_PORT=3001` in `.env` and recreating only the gateway. The original
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

## Pending rollout — 2026-10-12

Committed but **not yet deployed** anywhere:

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
