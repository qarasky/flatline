# Deployment

Production is one container on the office host, reachable through an existing
Cloudflare Tunnel. This document is the operational record: where things live,
how a release goes out, and how to get back.

## Topology

| Thing              | Location                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Public origin      | `https://uptime.mediaboost.kz`                                                                          |
| Tunnel target      | `http://localhost:3001` on the office host                                                              |
| Compose files      | `/home/office/flatline/compose.rust.yaml` + `/home/office/flatline-src/docker/compose.backups.yaml`     |
| Environment        | `/home/office/flatline/.env` — `FLATLINE_PORT=3001`, `FLATLINE_PUBLIC_URL=https://uptime.mediaboost.kz` |
| Data               | `/home/office/flatline/data-rust/flatline.db` (plus `initial-token.txt`, `status-page-secret`)          |
| Database backups   | Pre-release: `/home/office/flatline/backups/`. Nightly: `/mnt/mirror/flatline-nightly/` (RAID1)         |
| Backup storage     | `/mnt/mirror/flatline-backups` (RAID1 `md0`) → `/app/backups`; client bundles from backup agents        |
| Source tree        | `/home/office/flatline-src` — the tree the image is built from                                          |
| Provisioning token | `/home/office/flatline/provisioning-token.txt` (0600, root)                                             |
| Stack name         | `flatline-rust` (container `flatline-rust-flatline-1`)                                                  |

Docker runs **rootful** on this host: every docker command goes through `sudo`.
Inside the container the backend runs as the unprivileged `flatline` user (uid
and gid 10001), which owns `data-rust/` — see [the non-root image](#the-non-root-image).
The published port is loopback-only, so the tunnel is the only way in from
outside.

The office's `.env` supplies `FLATLINE_PUBLIC_URL`, which is what the
provisioning documents and installer use to render absolute URLs. Without it they
fall back to the request's `Host` header.

## Building the image

The image is built on the office from the source tree, for `linux/amd64`:

```bash
cd /home/office/flatline-src
sudo docker build --platform linux/amd64 -f docker/rust.dockerfile \
    -t artchsh/flatline-rust:office-live .
```

The Dockerfile builds three things and copies them into one runtime image: the
web app (Vite), the agent (Go, linux/amd64 and linux/arm64, with `VERSION` and
`sha256sums` beside the binaries) and the backend (Rust release). The
`docs/provisioning.md` runbook and `agent-install.sh` are copied to the
container root, where the backend's `include_str!` paths expect them.

Keep the source tree in sync (fetch the commit tarball or pull), and remember
that the tree is briefly stale until it is replaced: a build always reflects
what is on disk.

### The non-root image

The image runs the backend as `flatline` (uid/gid 10001). Its entrypoint
(`docker/entrypoint.sh`) starts as root only long enough to make sure
`/app/data` belongs to that user, then drops privileges with `setpriv` and
execs the backend (still PID 1, still handling SIGTERM itself).

- **Existing root-owned data needs no manual step.** On the first start of a
  non-root image the entrypoint finds the root-owned files in `data-rust/` and
  re-owns them (`entrypoint: handing /app/data to flatline` in the log); later
  starts find nothing to do. The manual equivalent, if ever wanted, is
  `sudo chown -R 10001:10001 /home/office/flatline/data-rust`.
- Host-side tools still work: root reads the 10001-owned files (backups,
  `initial-token.txt`), and a file root restores is handed back on the next
  start.
- ICMP monitors run `ping` without root. The image gives the binary
  `cap_net_raw` (permitted only), and the compose files set
  `net.ipv4.ping_group_range` so unprivileged ICMP sockets work even with
  `NET_RAW` dropped. A ping monitor failing with `Operation not permitted`
  means both were removed.
- The compose files also bound the container: `mem_limit: 1g`,
  `pids_limit: 1024` (threads count), `stop_grace_period: 30s` (the backend's
  graceful shutdown takes up to ~20 s) and json-file log rotation
  (`10m` × 5). The office copy of `compose.rust.yaml` must be updated from the
  repository copy for these to apply — the image alone does not carry them.

## Releasing

```bash
# One timestamp for the whole release: it names the image tag and the backup,
# and never collides with an earlier release the same day.
REL=$(date -u +%Y%m%d-%H%M%S)

# 1. Build the new image (to a scratch tag first, so a failure changes nothing).
#    This takes minutes; nothing below runs until it has succeeded.
cd /home/office/flatline-src
sudo docker build --platform linux/amd64 -f docker/rust.dockerfile \
    -t artchsh/flatline-rust:office-new .
sudo docker run --rm --entrypoint cat artchsh/flatline-rust:office-new /app/agent/VERSION

# 2. Keep the running image under a distinct, timestamped tag.
sudo docker tag artchsh/flatline-rust:office-live artchsh/flatline-rust:office-prev-$REL

# 3. Back up the database right before the recreate, consistently (SQLite
#    backup API, not cp), so the copy misses only seconds of data.
BM=/home/office/flatline/backups/pre-$REL.db
sudo python3 - "$BM" <<'PY'
import sqlite3, sys
live = sqlite3.connect("file:/home/office/flatline/data-rust/flatline.db?mode=ro", uri=True)
copy = sqlite3.connect(sys.argv[1])
with copy:
    live.backup(copy)
result = copy.execute("PRAGMA integrity_check").fetchone()[0]
print(result)
sys.exit(0 if result == "ok" else 1)
PY
sudo chmod 600 "$BM"

# 4. Promote and recreate (only once the backup printed ok).
sudo docker tag artchsh/flatline-rust:office-new artchsh/flatline-rust:office-live
cd /home/office/flatline && sudo docker compose -f compose.rust.yaml \
  -f /home/office/flatline-src/docker/compose.backups.yaml up -d
echo "rollback tag: office-prev-$REL  backup: $BM"
```

Run it as one block (or keep `REL` set) so the tag and the backup share the
timestamp; that pairing is what a rollback needs. Prune old `office-prev-*`
tags now and then (`sudo docker image ls artchsh/flatline-rust`).

Migrations run at startup, so the recreate is the whole database step. Recreate
is a few seconds of downtime on the public origin, plus up to ~20 s while the old
container shuts down gracefully (`stop_grace_period: 30s`).

### Verifying a release

```bash
sudo docker compose -f /home/office/flatline/compose.rust.yaml ps   # healthy, restarts 0
TOKEN=$(sudo cat /home/office/flatline/data-rust/initial-token.txt)
curl -fsS localhost:3001/healthz
curl -fsS -H "Authorization: Bearer $TOKEN" localhost:3001/api/v1/health
curl -fsS "localhost:3001/agent/version?token=$TOKEN"
curl -fsS "localhost:3001/add-push-server.md?token=$TOKEN" | sed -n '8,10p'
```

Check by hand, in order:

1. Container `healthy`, zero restarts; `/healthz` returns 200.
2. `/api/v1/health`: `total` equals the expected monitor count, `down` equals the
   monitors you expect to be down (usually zero).
3. The new migrations are applied — `SELECT version FROM _sqlx_migrations ORDER BY version`
   in the database — and any new columns exist.
4. `/agent/version` reports the expected version for `linux-amd64` and
   `linux-arm64`, and the served binary's sha256 matches `sha256sums`.
5. The runbook renders the right origin and agent version.
6. The public origin answers through the tunnel: `/`, `/status/<slug>`,
   `/superboard` and `/api/v1/auth/setup` return 200, and `/api/v1/monitors`
   returns 401 unauthenticated.
7. Every agent resumed pushing: newest telemetry per push monitor is seconds old.

## Rolling back

A code rollback is **not** enough on its own: `sqlx` refuses to start a binary
that does not know a migration the database has applied, so the database has to
go back with the code.

```bash
sudo docker tag artchsh/flatline-rust:office-prev-<REL> artchsh/flatline-rust:office-live
# stop the stack, restore the backup over data-rust/flatline.db, then:
cd /home/office/flatline && sudo docker compose -f compose.rust.yaml \
  -f /home/office/flatline-src/docker/compose.backups.yaml up -d
```

Restore the pre-release backup (`backups/pre-<REL>.db`, same timestamp as the
tag) whenever migrations shipped in the release you are backing out of. Rolling
back to an image from before the non-root change also works: it runs as root,
which can use the 10001-owned files, and the next non-root start re-owns
anything it wrote. If the release only changed code, the image swap alone is
enough. The Node-era rollback path no longer exists — see
[history](history.md).

## The fleet

Six monitors push telemetry (33 monitors in all on 2026-10-25); the rest are
HTTP/ICMP checks and groups. `office-mac-server` and `home-rpi` are no longer
monitored.

| Host                                                                           | Role                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `office-server`                                                                | The office machine itself (also runs this stack). |
| `cmn.kz`, `aiel-qorgan.kz`, `meks-zhkh`, `nationalbusiness.kz`, `zhasalash.kz` | Client hosts.                                     |

Backup agents run on `meks-zhkh` only: `modernization` and `zhkh`, linked to its
monitor, daily at 02:00 and 02:30 Asia/Almaty, encryption off, restore proven
on 2026-10-25. Bundles are kept on the office mirror (seven completed per
project, plus the latest restore-tested and archive-verified ones).

Monitor ids, group membership and notification links live in the dashboard; the
provisioning history for the client hosts is in the cabinet record, not here.

### Agent versions

The current release is **1.8.1**. Self-update exists only from 1.7.0, so a host
still on 1.6.1 needs one manual hop, per host:

```bash
curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update
```

Hosts already on 1.7.0 or newer pick up 1.8.1 themselves. Every monitored host
was on 1.8.0 when 1.8.1 shipped, so the whole fleet updates on its own.

1.8.0 carries the G1 fix (a restart during self-update could kill the helper
before it replaced the binary) and the audit's resource-cap fixes. Hosts on
1.7.0 take this one update with their old helper, which is still exposed to
G1; from 1.8.0 on, the agent rewrites its unit on first start and later updates
are safe.

1.8.1 raises the default `buffer_max_bytes` from 32 MiB to 256 MiB. At 1Hz and
~7.5KB per sample, 32 MiB held ~74 minutes, so the office server's 5-hour power
cut on 2026-10-23 cost each client host 5–16k samples. 256 MiB covers ~10 hours.
Hosts that set `buffer_max_bytes` explicitly keep their value.

### Backup agent versions

The backup agent (`flatline-backup`) is versioned separately: **0.3.0** is the
first build that updates itself (see [backup agent](backup-agent.md#self-update)).
The office image ships **0.3.1** (restore reuses one S3 client per target);
`master` carries 0.3.2 (clearer self-update log line), shipped with the next
deploy.
The image ships it under `/app/backup-agent` and serves it to backup agents at
`/api/backup/v1/release/*`; hosts check daily and install newer builds on their
own. A host on 0.2.0 needs one manual hop: install 0.3.0 from the image (verify
it against `sha256sums-backup`) and re-run `flatline-backup install --config …`
for each instance so the self-update units are written.

### Host-down noise

Agent hosts use `maxretries: 2` with `retryInterval: 180`. With `maxretries: 0`,
a single missed window (interval + 1 s) declares DOWN instantly and the parent
group amplifies it, which turned a provider blip into about ten Telegram
messages. With two retries a missed heartbeat reads as pending for roughly nine
minutes and only real outages page.

## Release log

| Date       | What shipped                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-13 | Rust backend cutover (parity-verified against the Node backend, then the Node backend was retired).                                                                                                                |
| 2026-10-14 | Performance/stability follow-up fixes; agent 1.6.0/1.6.1 rolled to the fleet.                                                                                                                                      |
| 2026-10-18 | Node backend removed from the repository; Superboard card redesign; hosted-website links; provider logos; agent-warning acknowledgements; agent 1.7.0 with self-update.                                            |
| 2026-10-21 | October performance and reliability audit (storage, engine, API, agent, dashboard findings) merged; backup agent integrated; agent 1.8.0.                                                                          |
| 2026-10-21 | Main board redesign (attention section, heartbeat strips, detail pane, motion) and the `heartbeat-strips` endpoint. Rollback tag `office-prev-20261021-144515`.                                                    |
| 2026-10-25 | Backup storage enabled; optional backup encryption (backup agent 0.2.0); QR sign-in; nightly DB backup timer installed. Agent stays 1.8.0. Rollback tag `office-prev-20261025-054357`.                             |
| 2026-10-25 | Agent 1.8.1 (256 MiB buffer) to the fleet via self-update; backup-agent self-update (0.3.0, migration 0015) and Superboard backup lines; meks hopped to 0.3.0 by hand. Rollback tag `office-prev-20261025-073124`. |
| 2026-10-25 | Backup agent 0.3.1: restore reuses one S3 client per target (0.3.0 stopped a stock Garage at ~1,000 objects). meks self-updated 0.3.0 → 0.3.1 on its update timer. Rollback tag `office-prev-20261025-075239`.     |

Each release is also recorded in [history](history.md) with the defects it fixed.

## Notes and known warts

- `data-rust/` is owned by uid 10001 (the container's `flatline` user), and
  `flatline.db` is mode 0644 inside a 0755 directory. Harmless with a single
  operator account; tighten it if other shell users ever appear.
- Docker does not restart an `unhealthy` container on its own; the off-host
  `/healthz` probe in [operations](operations.md#watching-the-watcher) is what
  notices an outage of the monitor itself.
- The image is built locally, so the office needs network access to the registry
  and to the Go/npm/Rust module mirrors on a cold cache. A warm cache rebuild is
  a couple of minutes.
- The old `uptime-kuma` container is stopped but not removed, and its data
  directory is untouched. It is no longer a rollback path.

## Backup storage

**Enabled on the office host since 2026-10-25.** Every `docker compose ... up`
there must pass both `compose.rust.yaml` and `compose.backups.yaml`: with the
first file alone the container is recreated without the backup mount and
uploads answer 503. `ps`, `logs` and `down` work with either form (same
project name).

Provisioning a new host (already done on office). Named backup agents need a
dedicated mount, separate from `data-rust/`:

```bash
sudo install -d -m 0700 /mnt/mirror/flatline-backups
uuidgen | tr 'A-Z' 'a-z' | sudo tee /mnt/mirror/flatline-backups/.flatline-backup-storage >/dev/null
sudo chmod 0600 /mnt/mirror/flatline-backups/.flatline-backup-storage
```

Then start the stack with the opt-in override:

```bash
cd /home/office/flatline
sudo docker compose -f compose.rust.yaml \
  -f /home/office/flatline-src/docker/compose.backups.yaml up -d
```

The override sets `FLATLINE_BACKUP_DIR=/app/backups` and refuses to create the
host path. Confirm `/mnt/mirror` is the RAID1 mount (`findmnt /mnt/mirror`)
before enabling it. Without the override, uploads answer 503; the service never
falls back to the container filesystem. Migrations 0012 and 0013 are additive
and apply at startup. Back up `data-rust/flatline.db` with SQLite's online
backup API before the first migration.
