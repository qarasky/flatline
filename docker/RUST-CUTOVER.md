# Rust backend cutover runbook

Status: **prepared, not executed.** The Node stack on office keeps running
until this runbook is walked. Nothing here touches the live `./data`
directory or the Node container.

The Rust backend (`backend-rs/`) is API-compatible with the surfaces the
operator and the agents use: push contract, monitors, heartbeats, metrics
(latest/bulk/summary/raw), SSE, notifications, API keys, badges,
status-page reads, OpenAPI and the SPA. The Go agent needs no change.

## 0. Known deltas (read before cutover)

- **Ping monitors are not implemented** (locked scope: push/http/group).
  The importer reports them and skips their heartbeats and status-page
  links. On the current fleet that is three monitors: `bes.media server`,
  `zhasalash server`, `Main server`. Decide before cutover: add a ping
  checker to the Rust backend, convert them to HTTP checks, or accept
  their loss (they are also the ones that keep the "server" rows on the
  status pages).
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

Keep the Node container and `./data` untouched. Only the tunnel port
changes.

```sh
cd /home/office/flatline
sudo docker compose -f compose.rust.yaml stop
FLATLINE_PORT=3001 sudo -E docker compose -f compose.rust.yaml up -d
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
stays under `data-rust/` for inspection.

## 7. After cutover

- Delete `data/kuma-pre-rust.db` once satisfied (it is a full copy of
  production).
- Re-check the three skipped ping monitors (section 0).
- The Rust backend prunes raw metrics at 30 days and rolls up hourly
  buckets at :12; no cron or external scheduler is needed.
- Logs: `sudo docker logs -f flatline-rust-flatline-1` (the Rust project
  is named `flatline-rust`; the retired Node container was
  `flatline-flatline-1`).

## 8. What is not covered here

Contract-level parity verification (M6) runs both backends against a copy
of this same database and compares responses field by field. Run it before
step 5 if any doubt remains; the runbook's staging phase is the natural
place.
