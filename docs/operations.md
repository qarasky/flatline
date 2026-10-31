# Operations

Day-two work: keeping the instance healthy, moving credentials, and getting out
of trouble. Deployment mechanics live in [deployment](deployment.md); the board's
own semantics live in [superboard](superboard.md). Named backup agents and
their offline restore procedure live in [backup-agent](backup-agent.md).

## Health checks

| Check         | Command / endpoint                                                  | Healthy means                                                                                                                         |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Containers    | `sudo docker compose -f /home/office/flatline/compose.rust.yaml ps` | `caddy`, `flatline` and `web` all `healthy`, low restart counts.                                                                      |
| Backend alive | `GET /healthz` (no token; Caddy routes it to the backend)           | 200 `{"status":"ok"}`: database answers within 2 s and the check engine's watchdog ticked within 30 s. 503 with a `reason` otherwise. |
| Web app alive | `GET /build` (no token)                                             | 200 `{"build":"<id>"}`: the Next.js server answers; the id is the deployed build.                                                     |
| Backend up    | `GET /api/v1/auth/setup` (no token)                                 | 200 with `setupNeeded` (proves the process and the database answer, nothing more).                                                    |
| Fleet summary | `GET /api/v1/health` (token)                                        | `total` matches the expected count, `down` matches reality; 503 when the database fails.                                              |
| Public origin | `curl -o /dev/null -w '%{http_code}' https://<origin>/`             | 200 through the tunnel.                                                                                                               |
| Agents        | newest telemetry per push monitor                                   | seconds old, not minutes.                                                                                                             |
| Local dev     | `./dev.sh status`                                                   | backend 200, web 200.                                                                                                                 |

The board itself is the best health signal: a fleet-wide problem shows as a
wall of stale cards, and `Agent: …` lines surface the host-side cause.

### Watching the watcher

The backend's healthcheck probes `/healthz` every 30 s (the web container's
probes `/build`), but Docker only _marks_
an unhealthy container; it never restarts it, and nothing inside the stack can
report that the stack itself is down. Something outside has to watch it:

- **Off-host check (required).** From a machine that is not the office host,
  probe the public origin every minute and alert when it fails — a
  healthchecks.io/uptime service HTTP check on `https://<origin>/healthz`, an
  HTTP monitor in another Flatline instance, or a cron/systemd-timer job:

  ```bash
  # crontab on another host: alert after a failed probe (5 s timeout).
  * * * * * curl -fsS -m 5 -o /dev/null https://uptime.mediaboost.kz/healthz \
      || curl -fsS -m 10 -o /dev/null "https://api.telegram.org/bot<bot>/sendMessage?chat_id=<chat>&text=Flatline+healthz+failing"
  ```

  This catches everything the instance cannot report about itself: host down,
  tunnel down, the backend wedged with a dead database or a stalled engine.
  `/healthz` passes through Caddy but not the web app; probe
  `https://<origin>/build` the same way to cover it.

- **On-host restart (optional).** If an unhealthy container should restart
  itself, a root cron entry is enough:

  ```bash
  */5 * * * * [ "$(docker inspect -f '{{.State.Health.Status}}' flatline-rust-flatline-1)" = unhealthy ] \
      && docker restart flatline-rust-flatline-1
  ```

  Keep the off-host check regardless: a restart loop is still an outage.

## Backups

Two different things are called backups here:

| What                        | Where (office)                                      | By                                                                  |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Flatline's own database     | `/mnt/mirror/flatline-nightly` (14 daily, 8 weekly) | `flatline-backup.timer`, 03:30 UTC (below)                          |
| Client data (Postgres, S3)  | `/mnt/mirror/flatline-backups` (7 per project)      | Backup agents on the client hosts ([backup-agent](backup-agent.md)) |
| Pre-release database copies | `/home/office/flatline/backups/` (single disk)      | The release procedure ([deployment](deployment.md))                 |

Everything is in the office building: the RAID1 mirror survives a disk, not a
fire or theft. No off-site copy is configured yet (`OFFSITE_TARGET` below
covers the nightly database only).

The database is a single SQLite file. Copy it with the **backup API**, never with
`cp` while the stack is running (a live copy can catch a torn write).

### Nightly backups

`docker/backup/` holds a small, self-contained nightly backup: a script plus a
systemd timer for the office host. It protects Flatline's own database (the
[backup agent](backup-agent.md) is a different thing: it ships client
application data, such as Postgres and object storage, to the office), and it
deliberately does one thing: every night it copies the live database
through the SQLite backup API over a read-only connection (the container keeps
running), refuses the copy unless `PRAGMA integrity_check` says `ok`, stores it
gzip'd, keeps **14 daily and 8 weekly** copies, and optionally mirrors the
backup directory off-host with rsync or rclone (skipped while no target is set).

Install, once, from the source tree:

```bash
cd /home/office/flatline-src
sudo install -m 0755 docker/backup/flatline-backup.sh /usr/local/sbin/flatline-backup
sudo install -m 0644 docker/backup/flatline-backup.service docker/backup/flatline-backup.timer /etc/systemd/system/
sudo install -m 0600 docker/backup/flatline-backup.env.example /etc/flatline-backup.env   # edit as needed
sudo systemctl daemon-reload
sudo systemctl enable --now flatline-backup.timer

# Run it once now and read the result.
sudo systemctl start flatline-backup.service
journalctl -u flatline-backup -n 20
ls -l /home/office/flatline/backups/nightly/daily/
```

- Defaults fit the office host: database `data-rust/flatline.db`, backups in
  `/home/office/flatline/backups/nightly/{daily,weekly}`, 03:30 (± 15 min), a run
  missed while the host was off happens at the next boot. Everything is
  overridable in `/etc/flatline-backup.env` (see the example file).
- **On the office host** (installed 2026-10-25) `/etc/flatline-backup.env` sets
  `BACKUP_DIR=/mnt/mirror/flatline-nightly`: the nightlies live on the RAID1
  mirror, not on the single disk that holds the live database. Check with
  `ls -l /mnt/mirror/flatline-nightly/daily/`.
- **Off-host copy:** set `OFFSITE_TARGET` (and `OFFSITE_TOOL=rsync|rclone`). The
  directory is mirrored with deletions, so the remote follows the rotation. A
  backup on the same disk does not survive the disk; set this.
- `NOTIFY_URL`, if set, is fetched after every successful run — point it at a
  dead-man's-switch check (healthchecks.io, or a push monitor on another
  instance) so a backup that silently stops running is noticed.
- A failed run (integrity check, missing tool, unreachable target) exits
  non-zero, so `systemctl --failed` and the journal show it.
- Restoring from a nightly: `gunzip -c <file>.db.gz > flatline.db`, then follow
  the restore steps below.
- Updating the script after a change in the repository: repeat the `install`
  lines; the timer keeps running.

### By hand

Before a release (see [deployment](deployment.md#releasing)) or whenever a copy
is needed right now:

```bash
BM=/home/office/flatline/backups/flatline-$(date -u +%Y%m%d-%H%M%S).db
python3 - "$BM" <<'PY'
import sqlite3, sys
live = sqlite3.connect("file:/home/office/flatline/data-rust/flatline.db?mode=ro", uri=True)
copy = sqlite3.connect(sys.argv[1])
with copy:
    live.backup(copy)
print("integrity:", copy.execute("PRAGMA integrity_check").fetchone()[0])
PY
chmod 600 "$BM"
```

- Take one **before every release**, right before the recreate, and keep it — a
  rollback generally needs it. The nightly copies do not replace it: they can be
  up to a day old.
- `PRAGMA integrity_check` on the copy must print `ok`; a backup you have not
  verified is not a backup.
- Backups are as sensitive as the live database: they contain tokens, incident
  text and the status-page password hashes. Keep them root-only and out of Git.
- Verify a restore by pointing a throwaway backend at the copy, not by restoring
  over production first (`DATA_DIR=<dir> PORT=3101 flatline-backend`).

Restoring: stop the stack, replace `data-rust/flatline.db` (and delete its
`-wal`/`-shm` siblings), start the stack. A file restored by root is fine: the
container's entrypoint hands anything in the data directory back to its
`flatline` user (uid 10001) on start. See
[deployment](deployment.md#rolling-back) for the paired image step.

## Accounts

People sign in to the web app with an email and password on **Members**
(`/members`); every account has full operator access. Anyone signed in adds a
person with a starting password, which they must change at first sign-in and
which expires after 7 days unchanged.

- **Forgotten password:** anyone signed in resets it from Members (the person
  is signed out everywhere and gets a new starting password).
- **Someone leaves:** remove them on Members and keep their tokens ticked, so
  the tokens they made are disabled with them.
- **No account left, or everyone locked out:** sign in with an operator token
  ("Use a token instead", for example the one in `data-rust/initial-token.txt`)
  and add or reset accounts from there. With no account at all the sign-in page
  also offers "Create the first account".
- Five failed sign-ins for one email (twenty per address) lock it for 15
  minutes; a token sign-in is not affected.

## Tokens

There are three credential families, told apart by prefix. Operator tokens
(`flatline_op_`) are full-permission bearers; push-agent tokens
(`flatline_agent_push_`) and backup-agent tokens (`flatline_agent_backup_`) are
agent-scoped and rejected by the operator API and GUI. Nothing is scoped beyond
that family boundary, so an operator token is only as narrow as the person
holding it. Legacy `flatline_...` tokens keep working until rotated.

| Credential         | Where it lives                                 | Rotating it                                                                                                                       |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Operator token     | `data-rust/initial-token.txt` (0600, root)     | Mint a replacement on **Tokens**, save it to that file, disable the old row.                                                      |
| Integration tokens | `tokens` table, hashes only                    | Mint a named token on **Tokens**; disable or delete it to revoke. Plaintext is shown once.                                        |
| Provisioning token | `/home/office/flatline/provisioning-token.txt` | Disable the key on **Tokens**, mint a replacement, update that file and any shared URL.                                           |
| Push tokens        | `monitors.push_token`, one per agent host      | Rotate in the monitor form (or `PATCH` the monitor), then update `/etc/superboard/config.json` on the host and restart the agent. |
| Backup credentials | `backup_agents.token_hash`, one per agent name | Rotate through `POST /api/v1/backup-agents/{id}/rotate-token`, then update the agent's token file.                                |
| Backup storage     | `/mnt/mirror/flatline-backups`                 | Enable only with `docker/compose.backups.yaml` after checking the mirror marker and free space.                                   |

Rules that keep this manageable:

- One named token per integration. A leak then costs one revoke, not a
  fleet-wide credential change.
- Tokens are bearer credentials: anything holding one _is_ the operator. They do
  not belong in a repository, a ticket, a screenshot or a chat log — which is why
  the provisioning documents are token-gated and Git-ignored paths hold the
  copies on disk.
- If a token does leak, disable it first and rotate second; revocation is
  immediate, including on open SSE streams.
- Push tokens are the exception worth distributing: an agent host holding only a
  push token can report its own monitor and download releases, nothing else. A
  push token used for GUI sign-in or `/api/v1` answers
  `agent_token_on_operator_api`, not a bare 401.
- Keep the two agent families apart: a backup-agent token only opens
  `/api/backup/v1`, a push-agent token only opens its push route and
  `/agent/*`.

### Restore test for a backup agent

Prove a restore before enabling an agent's daily timer, and again after a
bundle-format change. Run it on office against the stored bundle, into scratch
containers only; never into the client's services.

1. Start a scratch `postgres:16` (`POSTGRES_HOST_AUTH_METHOD=trust`) and an
   empty database per source database, and a scratch Garage (single node,
   `replication_factor = 1`, layout assigned) with an empty bucket per source
   bucket and a read/write key; keep files under `/mnt/mirror/<scratch dir>`.
2. Copy `flatline-backup` out of the running image
   (`/app/backup-agent/flatline-backup-linux-amd64`).
3. Write a `restore-target.json` mapping each source database and bucket to its
   scratch target ([backup-agent](backup-agent.md#recovery)), then run
   `restore` and `compare` against
   `/mnt/mirror/flatline-backups/agents/<agent>/<run>/bundle.age`.
4. Record the result so the dashboard shows it:
   `POST /api/v1/backup-runs/{runId}/verification` with
   `{"kind":"restore","status":"passed","checkedAt":…,"summary":…}`.
5. Remove the scratch containers, their data and images.

The 2026-10-25 test of meks restored `sem` (19 objects) and `modernization`
(1,375 objects) this way; it also found the restore bug fixed in 0.3.1.

## Updating the agent fleet

Both agents update themselves from the image. The server ships the telemetry
agent and agents pull it; details and the manual first hop are in
[deployment](deployment.md#agent-versions) and [agent](agent.md). Backup agents
check daily too ([backup-agent](backup-agent.md#self-update)); a host on a
build older than 0.3.0 needs one manual install.

```bash
curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update
```

## Diagnosing

| Symptom                                  | Look at                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A monitor stays pending                  | Agent: `systemctl status superboard`, `journalctl -u superboard -n 50`, `sudo superboard check`. Server: `GET /api/v1/monitors/{id}` for `active` and `pushToken`.                                                         |
| A monitor flips down and back            | Network path from that host to the origin, and the monitor's `maxretries`/`retryInterval`. The agent buffers on disk, so short blips arrive late rather than lost.                                                         |
| The board is stale but checks work       | SSE: the proxy in front of the app must not buffer responses and must allow idle connections longer than the keepalive. Caddy flushes backend responses as written; anything in front of Caddy must not buffer either.     |
| Public origin down, containers up        | The tunnel, then the published port (`127.0.0.1:3001`, Caddy): `curl -sS localhost:3001/healthz` reaches the backend, `curl -sS localhost:3001/build` the web app.                                                         |
| Pages fail to load, the API answers      | The web app: `sudo docker logs flatline-rust-web-1`. It renders by calling the backend at `API_URL` (`http://flatline:3001`); an admin page that cannot reach it says "Flatline may be restarting" and retries on its own. |
| Every path answers `502`                 | Caddy cannot reach `flatline` or `web` (down or restarting): `sudo docker logs flatline-rust-caddy-1`, then the compose `ps` above. Caddy waits for both to report healthy before it starts.                               |
| Cards show agent warnings                | The tooltip has the per-collector detail and the last push error; right-click → Clear agent warnings once seen. A collector failing forever usually means a host-side tool (driver mismatch, missing `smartctl`).          |
| Database growing                         | Expected: 30 days of 30-second samples plus two years of hourly rollups. Monitor `du -sh data-rust/`; a sudden jump usually means a monitor was added, not a leak. The `-wal` file is capped at ~64 MB after checkpoints.  |
| Agents log `503` from the push endpoint  | The database refused a write (lock timeout, disk full). Agents keep the samples and retry after `Retry-After`; check `df`, then the backend log for the `push:` error. Nothing is lost while the agent buffer has room.    |
| Container `unhealthy`                    | `curl -sS localhost:3001/healthz` says which part failed (database or engine); then the backend log. Docker will not restart it on its own — see [watching the watcher](#watching-the-watcher).                            |
| `/healthz` answers 503                   | The `reason` field: `database error` / `database probe timed out` (lock contention or a full disk), `engine watchdog stalled` (the runtime is wedged; the logs say which loop).                                            |
| Alerts arrive as one summary             | Expected under pressure: when four or more alerts wait for one chat, they are coalesced into a single message listing each in order. `notify:` log lines show rate limiting (`429`) and drops.                             |
| `engine: … panicked` in the logs         | A check loop crashed and was respawned with backoff; the monitor keeps being checked. Report the message — it is a bug.                                                                                                    |
| Backend exits at boot: config error      | `PORT` or `FLATLINE_HEARTBEAT_RETENTION_DAYS` is set but not a valid number; the message names the variable and value. Fix or unset it.                                                                                    |
| API answers `503 unavailable`            | The token store could not be read (database locked or failing); clients keep their token and retry. Check the logs for `auth: token store unavailable`.                                                                    |
| `503 timeout` / `503 busy`               | A request exceeded its 30 s budget or 256 requests were in flight: the database is the usual bottleneck. SSE and agent downloads are not timed.                                                                            |
| Status pages or badges answer `429`      | More than 16 public reads in flight (responses are cached 10 s, so this means a flood). Clients are told to retry after 5 s.                                                                                               |
| Imported keys answer `429`               | Over 30 failed bcrypt key checks in a minute; wait a minute. Cached keys and `flatline_` tokens are unaffected.                                                                                                            |
| Backend will not start after a downgrade | The database has newer migrations than the binary. Restore the matching backup.                                                                                                                                            |

## Logs

| What      | Where                                                                    |
| --------- | ------------------------------------------------------------------------ |
| Backend   | `sudo docker logs flatline-rust-flatline-1` (JSON lines, one per event). |
| Web app   | `sudo docker logs flatline-rust-web-1` (the Next.js server).             |
| Caddy     | `sudo docker logs flatline-rust-caddy-1`.                                |
| Backups   | `journalctl -u flatline-backup` on the office host.                      |
| Agent     | `journalctl -u superboard` on the host.                                  |
| Local dev | `.dev-logs/` (`dev.sh logs` follows them).                               |

The backend logs at `info` for lifecycle events and `warn`/`error` for failures;
ingest and rollup problems are logged with the monitor id, which is what makes a
stale card traceable to a cause.

Container logs rotate at 10 MB × 5 files (`logging` in the compose files), so
`docker logs` reaches back about 50 MB; ship them elsewhere if longer history is
needed.

## Repository hygiene

Git-ignored, and never committed: `data/`, `.dev-data/`, `.dev-logs/`, `private/`,
`tmp/`, `backend-rs/target/`, `node_modules/` and the web app's build output
(`apps/web/.next/`). Production
credentials live on the office host under `/home/office/flatline/`, not in this
repository.
