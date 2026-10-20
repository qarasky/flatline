# Operations

Day-two work: keeping the instance healthy, moving credentials, and getting out
of trouble. Deployment mechanics live in [deployment](deployment.md); the board's
own semantics live in [superboard](superboard.md).

## Health checks

| Check         | Command / endpoint                                                  | Healthy means                                                                                                                         |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Container     | `sudo docker compose -f /home/office/flatline/compose.rust.yaml ps` | `healthy`, low restart count.                                                                                                         |
| Backend alive | `GET /healthz` (no token)                                           | 200 `{"status":"ok"}`: database answers within 2 s and the check engine's watchdog ticked within 30 s. 503 with a `reason` otherwise. |
| Backend up    | `GET /api/v1/auth/setup` (no token)                                 | 200 (static: proves the process answers, nothing more).                                                                               |
| Fleet summary | `GET /api/v1/health` (token)                                        | `total` matches the expected count, `down` matches reality; 503 when the database fails.                                              |
| Public origin | `curl -o /dev/null -w '%{http_code}' https://<origin>/`             | 200 through the tunnel.                                                                                                               |
| Agents        | newest telemetry per push monitor                                   | seconds old, not minutes.                                                                                                             |
| Local dev     | `./dev.sh status`                                                   | backend 200, dashboard 200.                                                                                                           |

The dashboard itself is the best health signal: a fleet-wide problem shows as a
wall of stale cards, and `Agent: …` lines surface the host-side cause.

### Watching the watcher

The container healthcheck probes `/healthz` every 30 s, but Docker only _marks_
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

- **On-host restart (optional).** If an unhealthy container should restart
  itself, a root cron entry is enough:

  ```bash
  */5 * * * * [ "$(docker inspect -f '{{.State.Health.Status}}' flatline-rust-flatline-1)" = unhealthy ] \
      && docker restart flatline-rust-flatline-1
  ```

  Keep the off-host check regardless: a restart loop is still an outage.

## Backups

The database is a single SQLite file. Copy it with the **backup API**, never with
`cp` while the stack is running (a live copy can catch a torn write).

### Nightly backups

`docker/backup/` holds a small, self-contained nightly backup: a script plus a
systemd timer for the office host. It is the **interim, simple** backup — a
fuller backup-agent feature is being built separately and will supersede it —
so it deliberately does one thing: every night it copies the live database
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

## Tokens

There is one credential type — a bearer token with full permission — plus
per-monitor push tokens. Nothing is scoped, so a token is only as narrow as the
person holding it.

| Credential         | Where it lives                                 | Rotating it                                                                                                                       |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Operator token     | `data-rust/initial-token.txt` (0600, root)     | Mint a replacement in the Agents panel, save it to that file, disable the old row.                                                |
| Integration tokens | `tokens` table, hashes only                    | Mint a named token in the Agents panel; disable or delete it to revoke. Plaintext is shown once.                                  |
| Provisioning token | `/home/office/flatline/provisioning-token.txt` | Disable the key in the Agents panel, mint a replacement, update that file and any shared URL.                                     |
| Push tokens        | `monitors.push_token`, one per agent host      | Rotate in the monitor form (or `PATCH` the monitor), then update `/etc/superboard/config.json` on the host and restart the agent. |

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
  push token can report its own monitor and download releases, nothing else.

## Updating the agent fleet

The server ships the agent, agents pull it. Details and the manual first hop are
in [deployment](deployment.md#agent-versions) and [agent](agent.md).

```bash
curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update
```

## Diagnosing

| Symptom                                  | Look at                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A monitor stays pending                  | Agent: `systemctl status superboard`, `journalctl -u superboard -n 50`, `sudo superboard check`. Server: `GET /api/v1/monitors/{id}` for `active` and `pushToken`.                                                        |
| A monitor flips down and back            | Network path from that host to the origin, and the monitor's `maxretries`/`retryInterval`. The agent buffers on disk, so short blips arrive late rather than lost.                                                        |
| The board is stale but checks work       | SSE: the proxy in front of the app must not buffer responses and must allow idle connections longer than the keepalive.                                                                                                   |
| Public origin down, container up         | The tunnel, then the published port (`127.0.0.1:3001`).                                                                                                                                                                   |
| Cards show agent warnings                | The tooltip has the per-collector detail and the last push error; right-click → Clear agent warnings once seen. A collector failing forever usually means a host-side tool (driver mismatch, missing `smartctl`).         |
| Database growing                         | Expected: 30 days of 30-second samples plus two years of hourly rollups. Monitor `du -sh data-rust/`; a sudden jump usually means a monitor was added, not a leak. The `-wal` file is capped at ~64 MB after checkpoints. |
| Agents log `503` from the push endpoint  | The database refused a write (lock timeout, disk full). Agents keep the samples and retry after `Retry-After`; check `df`, then the backend log for the `push:` error. Nothing is lost while the agent buffer has room.   |
| Container `unhealthy`                    | `curl -sS localhost:3001/healthz` says which part failed (database or engine); then the backend log. Docker will not restart it on its own — see [watching the watcher](#watching-the-watcher).                           |
| `/healthz` answers 503                   | The `reason` field: `database error` / `database probe timed out` (lock contention or a full disk), `engine watchdog stalled` (the runtime is wedged; the logs say which loop).                                           |
| Alerts arrive as one summary             | Expected under pressure: when four or more alerts wait for one chat, they are coalesced into a single message listing each in order. `notify:` log lines show rate limiting (`429`) and drops.                            |
| `engine: … panicked` in the logs         | A check loop crashed and was respawned with backoff; the monitor keeps being checked. Report the message — it is a bug.                                                                                                   |
| Backend will not start after a downgrade | The database has newer migrations than the binary. Restore the matching backup.                                                                                                                                           |

## Logs

| What      | Where                                                                    |
| --------- | ------------------------------------------------------------------------ |
| Backend   | `sudo docker logs flatline-rust-flatline-1` (JSON lines, one per event). |
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
`tmp/`, `backend-rs/target/`, `node_modules/` and the built dashboard. Production
credentials live on the office host under `/home/office/flatline/`, not in this
repository.
