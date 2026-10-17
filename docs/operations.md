# Operations

Day-two work: keeping the instance healthy, moving credentials, and getting out
of trouble. Deployment mechanics live in [deployment](deployment.md); the board's
own semantics live in [superboard](superboard.md).

## Health checks

| Check | Command / endpoint | Healthy means |
|---|---|---|
| Container | `sudo docker compose -f /home/office/flatline/compose.rust.yaml ps` | `healthy`, low restart count. |
| Backend up | `GET /api/v1/auth/setup` (no token) | 200. Also the container healthcheck. |
| Fleet summary | `GET /api/v1/health` (token) | `total` matches the expected count, `down` matches reality. |
| Public origin | `curl -o /dev/null -w '%{http_code}' https://<origin>/` | 200 through the tunnel. |
| Agents | newest telemetry per push monitor | seconds old, not minutes. |
| Local dev | `./dev.sh status` | backend 200, dashboard 200. |

The dashboard itself is the best health signal: a fleet-wide problem shows as a
wall of stale cards, and `Agent: …` lines surface the host-side cause.

## Backups

The database is a single SQLite file. Copy it with the **backup API**, never with
`cp` while the stack is running (a live copy can catch a torn write):

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

- Take one **before every release**, and keep it — a rollback generally needs it.
- `PRAGMA integrity_check` on the copy must print `ok`; a backup you have not
  verified is not a backup.
- Backups are as sensitive as the live database: they contain tokens, incident
  text and the status-page password hashes. Keep them root-only and out of Git.
- Verify a restore by pointing a throwaway backend at the copy, not by restoring
  over production first (`DATA_DIR=<dir> PORT=3101 flatline-backend`).

Restoring: stop the stack, replace `data-rust/flatline.db` (and delete its
`-wal`/`-shm` siblings), start the stack. See
[deployment](deployment.md#rolling-back) for the paired image step.

## Tokens

There is one credential type — a bearer token with full permission — plus
per-monitor push tokens. Nothing is scoped, so a token is only as narrow as the
person holding it.

| Credential | Where it lives | Rotating it |
|---|---|---|
| Operator token | `data-rust/initial-token.txt` (0600, root) | Mint a replacement in the Agents panel, save it to that file, disable the old row. |
| Integration tokens | `tokens` table, hashes only | Mint a named token in the Agents panel; disable or delete it to revoke. Plaintext is shown once. |
| Provisioning token | `/home/office/flatline/provisioning-token.txt` | Disable the key in the Agents panel, mint a replacement, update that file and any shared URL. |
| Push tokens | `monitors.push_token`, one per agent host | Rotate in the monitor form (or `PATCH` the monitor), then update `/etc/superboard/config.json` on the host and restart the agent. |

Rules that keep this manageable:

- One named token per integration. A leak then costs one revoke, not a
  fleet-wide credential change.
- Tokens are bearer credentials: anything holding one *is* the operator. They do
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

| Symptom | Look at |
|---|---|
| A monitor stays pending | Agent: `systemctl status superboard`, `journalctl -u superboard -n 50`, `sudo superboard check`. Server: `GET /api/v1/monitors/{id}` for `active` and `pushToken`. |
| A monitor flips down and back | Network path from that host to the origin, and the monitor's `maxretries`/`retryInterval`. The agent buffers on disk, so short blips arrive late rather than lost. |
| The board is stale but checks work | SSE: the proxy in front of the app must not buffer responses and must allow idle connections longer than the keepalive. |
| Public origin down, container up | The tunnel, then the published port (`127.0.0.1:3001`). |
| Cards show agent warnings | The tooltip has the per-collector detail and the last push error; right-click → Clear agent warnings once seen. A collector failing forever usually means a host-side tool (driver mismatch, missing `smartctl`). |
| Database growing | Expected: 30 days of 30-second samples plus two years of hourly rollups. Monitor `du -sh data-rust/`; a sudden jump usually means a monitor was added, not a leak. |
| Backend will not start after a downgrade | The database has newer migrations than the binary. Restore the matching backup. |

## Logs

| What | Where |
|---|---|
| Backend | `sudo docker logs flatline-rust-flatline-1` (JSON lines, one per event). |
| Agent | `journalctl -u superboard` on the host. |
| Local dev | `.dev-logs/` (`dev.sh logs` follows them). |

The backend logs at `info` for lifecycle events and `warn`/`error` for failures;
ingest and rollup problems are logged with the monitor id, which is what makes a
stale card traceable to a cause.

## Repository hygiene

Git-ignored, and never committed: `data/`, `.dev-data/`, `.dev-logs/`, `private/`,
`tmp/`, `backend-rs/target/`, `node_modules/` and the built dashboard. Production
credentials live on the office host under `/home/office/flatline/`, not in this
repository.
