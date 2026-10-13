# Rust backend cutover runbook

Status: **executed 2026-10-13.** The office origin now runs the Rust
backend; the Node stack is stopped and kept for rollback. The record and
rollback commands are in `docker/OFFICE-DEPLOYMENT.md` ("Cutover to the
Rust backend"). This document remains the procedure for a re-run or for
another host.

The Rust backend (`backend-rs/`) is API-compatible with the surfaces the
operator and the agents use: push contract, monitors, heartbeats, metrics
(latest/bulk/summary/raw), SSE, notifications, API keys, badges,
status-page reads, OpenAPI and the SPA. The Go agent needs no change.

## 0. Known deltas (read before cutover)

- **Ping monitors are supported** (added after the M5 import validation):
  the checker runs the system `ping` binary, the image installs
  `iputils-ping`, and the importer carries the fleet's three ICMP
  monitors (`bes.media server`, `zhasalash server`, `Main server`) over
  with their heartbeats and status-page links. ICMP requires the container
  to be allowed to send raw sockets — Docker's default is fine, but a
  hardened runtime (no NET_RAW) would need adjusting.
- Maintenance windows, tags and status-page authoring do not exist in v1.
  Imported pages are read-only; incidents/maintenance are not editable
  through the API yet.
- Notification editing has a small API (`/api/v1/notifications`) instead
  of a UI form.
- The dashboard sign-in accepts the admin token as the password; the
  existing SPA is served unchanged.

## 1. Build the image (build machine, linux/amd64)

```sh
docker build --platform linux/amd64 -f docker/rust.dockerfile \
    -t artchsh/flatline-rust:office-live .
docker save artchsh/flatline-rust:office-live | gzip > flatline-rust.tgz
```

## 2. Transfer and load (office)

```sh
scp flatline-rust.tgz office@100.120.148.13:/home/office/flatline/
ssh office@100.120.148.13
cd /home/office/flatline
sudo docker load < flatline-rust.tgz
```

## 3. Import a copy of the live database

The importer opens the old database **read-only** and writes a fresh one
under `data-rust/`. Use SQLite's backup API for a consistent copy of a
running database.

```sh
# Consistent copy of the live DB (inside the running container).
sudo docker exec flatline-flatline-1 \
    sqlite3 /app/data/kuma.db ".backup /app/data/kuma-pre-rust.db"

# Run the importer in the Rust image; it refuses to touch the old file.
sudo docker run --rm -v /home/office/flatline:/work -w /work \
    artchsh/flatline-rust:office-live \
    flatline-backend import --from /work/data/kuma-pre-rust.db --data-dir /work/data-rust

# Staging only: mute notifications so the second backend never alerts
# alongside the live Node stack. The cutover re-import (step 5) restores
# the live notification config from a fresh copy.
sudo docker run --rm -v /home/office/flatline/data-rust:/data \
    --entrypoint sqlite3 artchsh/flatline:office-live \
    /data/flatline.db "UPDATE notifications SET active = 0"
```

The report lists every imported table and **warns loudly about skipped
monitors**. The new admin token lands in `data-rust/initial-token.txt`
(0600, root-owned — read it with `sudo cat`). Keep it; it is the operator
sign-in credential.

## 4. Stage on loopback port 3101

Copy `docker/compose.rust.yaml` from the repo to
`/home/office/flatline/compose.rust.yaml`, then:

```sh
cd /home/office/flatline
FLATLINE_PORT=3101 sudo -E docker compose -f compose.rust.yaml up -d
curl -fsS http://127.0.0.1:3101/api/v1/auth/setup
```

The compose project is named `flatline-rust`, so the Node stack
(`flatline-flatline-1`) keeps running untouched while both are up.

Verify against the **imported copy** (token from step 3):

```sh
TOKEN=$(sudo cat data-rust/initial-token.txt)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3101/api/v1/health
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3101/api/v1/monitors?perPage=200 | head -c 400
curl -fsS http://127.0.0.1:3101/api/status-page/clients | head -c 400
```

Checklist:

- [ ] `health.total` matches the old dashboard's monitor count minus the
      skipped ping monitors; no unexpected DOWN.
- [ ] A push monitor's `pushToken` from the old UI still accepts a push
      (`/api/push/<token>?telemetry=1`) and `metrics/latest` updates.
- [ ] Heartbeats and metrics history look continuous
      (`/api/v1/monitors/46/heartbeats?limit=5`).
- [ ] Status page loads (password prompt first, then content after
      unlock) and badges render.
- [ ] `initial-token.txt` token signs in on the dashboard.
- [ ] Telegram: temporarily link one test monitor and confirm a real
      message (or trust the imported notification and verify after
      cutover with a `status=down` push).
- [ ] OpenAPI at `/api/v1/openapi.json` lists the Rust surface.

## 5. Cutover

The staging copy misses everything the live stack recorded while it was
up (agent pushes, heartbeats), so cutover re-imports a fresh copy of the
just-stopped database. The Node stack and its `./data` stay untouched for
rollback; only the tunnel port changes owner.

```sh
cd /home/office/flatline

# 1. Stop the Rust staging stack (frees 3101).
sudo docker compose -f compose.rust.yaml down

# 2. Stop the live Node stack (frees 3001; alerts pause for ~2 minutes).
sudo docker compose stop

# 3. Consistent copy of the now-quiescent database and a fresh import.
sudo docker run --rm -v /home/office/flatline/data:/data \
    --entrypoint sqlite3 artchsh/flatline:office-live \
    /data/kuma.db ".backup /data/kuma-cutover.db"
sudo docker run --rm -v /home/office/flatline:/work -w /work \
    artchsh/flatline-rust:office-live \
    flatline-backend import --from /work/data/kuma-cutover.db --data-dir /work/data-rust --force

# 4. Start the Rust stack on the tunnel port. Notifications are active in
#    the fresh import, so alerts resume immediately.
FLATLINE_PORT=3001 sudo -E docker compose -f compose.rust.yaml up -d

# 5. Verify through the public origin.
curl -fsS https://uptime.mediaboost.kz/api/v1/auth/setup
```

Agents keep pushing to the same origin with the same tokens; the tunnel
does not change.

## 6. Rollback

```sh
cd /home/office/flatline
sudo docker compose -f compose.rust.yaml down
sudo docker compose up -d          # the Node stack, original ./data
```

Nothing in the Rust path writes to `./data`; the original database is
exactly as it was. If the Rust stack ran long enough to matter, its DB
stays under `data-rust/` for inspection. Alerts pause for the seconds it
takes the Node stack to come back.

## 7. After cutover

- Delete `data/kuma-pre-rust.db` once satisfied (it is a full copy of
  production).
- The Rust backend prunes raw metrics at 30 days and rolls up hourly
  buckets at :12; no cron or external scheduler is needed.
- Logs: `sudo docker logs -f flatline-rust-flatline-1` (the Rust project
  is named `flatline-rust`; the retired Node container was
  `flatline-flatline-1`).

## 8. What is not covered here

Contract-level parity verification (M6) is implemented: run
`python3 docker/parity-contract.py --prod-db <copy>` before step 5 — it
starts both backends on copies of the same database and diffs ~115 checks
across every surface (see `docker/RUST-PARITY.md`, including the manual
golden-path checklist). The staging phase in step 4 is the natural place
to walk that checklist.
