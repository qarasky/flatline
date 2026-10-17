# Deployment

Production is one container on the office host, reachable through an existing
Cloudflare Tunnel. This document is the operational record: where things live,
how a release goes out, and how to get back.

## Topology

| Thing | Location |
|---|---|
| Public origin | `https://uptime.mediaboost.kz` |
| Tunnel target | `http://localhost:3001` on the office host |
| Compose file | `/home/office/flatline/compose.rust.yaml` (repository copy: `docker/compose.rust.yaml`) |
| Environment | `/home/office/flatline/.env` — `FLATLINE_PORT=3001`, `FLATLINE_PUBLIC_URL=https://uptime.mediaboost.kz` |
| Data | `/home/office/flatline/data-rust/flatline.db` (plus `initial-token.txt`, `status-page-secret`) |
| Backups | `/home/office/flatline/backups/` |
| Source tree | `/home/office/flatline-src` — the tree the image is built from |
| Provisioning token | `/home/office/flatline/provisioning-token.txt` (0600, root) |
| Stack name | `flatline-rust` (container `flatline-rust-flatline-1`) |

Docker runs **rootful** on this host: every docker command goes through `sudo`,
and files under `data-rust/` are root-owned. The published port is loopback-only,
so the tunnel is the only way in from outside.

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

## Releasing

```bash
# 1. Back up the database, consistently (SQLite backup API, not cp).
BM=/home/office/flatline/backups/pre-$(date -u +%Y%m%d-%H%M%S).db
python3 - "$BM" <<'PY'
import sqlite3, sys
live = sqlite3.connect("file:/home/office/flatline/data-rust/flatline.db?mode=ro", uri=True)
copy = sqlite3.connect(sys.argv[1])
with copy:
    live.backup(copy)
print(copy.execute("PRAGMA integrity_check").fetchone()[0])
PY
chmod 600 "$BM"

# 2. Keep the running image under a distinct tag.
sudo docker tag artchsh/flatline-rust:office-live \
    artchsh/flatline-rust:office-prev-$(date -u +%Y%m%d)

# 3. Build the new image (to a scratch tag first, so a failure changes nothing).
cd /home/office/flatline-src
sudo docker build --platform linux/amd64 -f docker/rust.dockerfile \
    -t artchsh/flatline-rust:office-new .
sudo docker run --rm --entrypoint cat artchsh/flatline-rust:office-new /app/agent/VERSION

# 4. Promote and recreate.
sudo docker tag artchsh/flatline-rust:office-new artchsh/flatline-rust:office-live
cd /home/office/flatline && sudo docker compose -f compose.rust.yaml up -d
```

Migrations run at startup, so the recreate is the whole database step. Recreate
is a few seconds of downtime on the public origin.

### Verifying a release

```bash
sudo docker compose -f /home/office/flatline/compose.rust.yaml ps   # healthy, restarts 0
TOKEN=$(sudo cat /home/office/flatline/data-rust/initial-token.txt)
curl -fsS -H "Authorization: Bearer $TOKEN" localhost:3001/api/v1/health
curl -fsS "localhost:3001/agent/version?token=$TOKEN"
curl -fsS "localhost:3001/add-push-server.md?token=$TOKEN" | sed -n '8,10p'
```

Check by hand, in order:

1. Container `healthy`, zero restarts.
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
sudo docker tag artchsh/flatline-rust:office-prev-<date> artchsh/flatline-rust:office-live
# stop the stack, restore the backup over data-rust/flatline.db, then:
sudo docker compose -f compose.rust.yaml up -d
```

Restore the pre-release backup whenever migrations shipped in the release you
are backing out of. If the release only changed code, the image swap alone is
enough. The Node-era rollback path no longer exists — see
[history](history.md).

## The fleet

Eight monitors push telemetry; the rest are HTTP/ICMP checks and groups.

| Host | Role |
|---|---|
| `office-server` | The office machine itself (also runs this stack). |
| `office-mac-server` | A Mac used as a server. |
| `home-rpi` | Home Raspberry Pi. |
| `cmn.kz`, `aiel-qorgan.kz`, `meks-zhkh`, `nationalbusiness.kz`, `zhasalash.kz` | Client hosts. |

Monitor ids, group membership and notification links live in the dashboard; the
provisioning history for the client hosts is in the cabinet record, not here.

### Agent versions

The fleet is being moved from **1.6.1** to **1.7.0**. Self-update exists only
from 1.7.0, so the first hop is manual, per host:

```bash
curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update
```

After that each host keeps itself current. `home-rpi` and `office-mac-server`
report no agent version at all and need the same one-liner to join.

### Host-down noise

Agent hosts use `maxretries: 2` with `retryInterval: 180`. With `maxretries: 0`,
a single missed window (interval + 1 s) declares DOWN instantly and the parent
group amplifies it, which turned a provider blip into about ten Telegram
messages. With two retries a missed heartbeat reads as pending for roughly nine
minutes and only real outages page.

## Release log

| Date | What shipped |
|---|---|
| 2026-10-13 | Rust backend cutover (parity-verified against the Node backend, then the Node backend was retired). |
| 2026-10-14 | Performance/stability follow-up fixes; agent 1.6.0/1.6.1 rolled to the fleet. |
| 2026-10-18 | Node backend removed from the repository; Superboard card redesign; hosted-website links; provider logos; agent-warning acknowledgements; agent 1.7.0 with self-update. |

Each release is also recorded in [history](history.md) with the defects it fixed.

## Notes and known warts

- `data-rust/flatline.db` is mode 0644 inside a 0755 directory. Harmless with a
  single operator account; tighten it if other shell users ever appear.
- The image is built locally, so the office needs network access to the registry
  and to the Go/npm/Rust module mirrors on a cold cache. A warm cache rebuild is
  a couple of minutes.
- The old `uptime-kuma` container is stopped but not removed, and its data
  directory is untouched. It is no longer a rollback path.
