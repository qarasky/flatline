# Rust parity verification (M6)

The Rust backend was compared against the Node backend serving from copies
of the same database — the real production data — with every read response
diffed field by field and the write paths exercised on both sides.

## How to run it

```sh
# A consistent copy of the production database (SQLite backup API):
#   docker exec flatline-flatline-1 sqlite3 /app/data/kuma.db ".backup /tmp/kuma.db"

python3 docker/parity-contract.py --prod-db /path/to/kuma.db
```

The script builds a workdir, copies the database twice, deactivates
monitors and notifications in the copies (no live checks, no duplicate
alerts), starts the Node backend on :3990, imports the same database with
`flatline-backend import`, starts the Rust backend on :3991, runs ~115
checks, prints a report and exits non-zero on any failure.

## Result (2026-10-13, production copy)

```
contract comparison: 115/115 checks passed
```

Covered, with the comparison rules:

| Surface | Checks |
|---|---|
| auth | `/setup` exact, wrong-credential login 401 on both, token-as-password on the Rust side, missing token 401 |
| health | counts and `downMonitors` exact |
| monitors | every Node field present and equal on the Rust side (id, name, type, status, ping, lastCheck, lastMessage, active, interval, weight, parent, url, pushToken, hostname, thresholds, `uptime24h` within 0.02); list filters; single monitor; 404s |
| heartbeats | `total`/`limit` exact; the newest rows byte-equal (time, status, ping, msg, important); bad-limit 400 |
| metrics | bulk + single latest (time and payload deep-equal), summary raw tier (samples, first/last, bucket seconds, series length, stats within 1e-6), long-tier shape, raw rows equal |
| notifications | count and redaction (no bot token) |
| status pages | config field-by-field, groups/monitors identical, heartbeat statuses, 24h uptime within 0.02, incident history, host resolution |
| badges | status badge aria-label exact; uptime label + value within 1 point; ping/response/avg-response labels |
| push contract | create (201, `ignoredFields`), legacy push beat row equal, telemetry fast path (no extra heartbeat), explicit down, unknown token 404, oversized metrics 400 with the heartbeat kept |
| API keys | field shape, create 201, minted token authenticates, delete |

## Documented differences (reported, not failures)

These are deliberate scope decisions or Node bugs the Rust side fixes.
They are printed as INFO lines by the script:

1. **Uptime 7d/30d with heartbeat gaps.** Node's stat tables count only
   minutes that received a beat, so gaps (agent off, backend down) vanish
   from its ratio. The Rust method — the plan's deliberate simplification —
   extends the last known status through a gap (a dead-man reading).
   Example: `office` (43) has an 18h gap after a DOWN beat; Node reports
   `0.975`, the Rust `0.825`. `uptime24h` is compared strictly and matches.
2. **`?status=` filter.** Node compares the numeric status to the string
   query (`1 !== "up"`) and always returns `[]`; the Rust implements the
   documented `up/down/pending/maintenance` values.
3. **`monitor-types` scope.** Node advertises 29 types (docker, dns, mqtt,
   …) of which the fleet uses four; the Rust advertises exactly its
   supported set — `http`, `https`, `push`, `ping`, `group`. Every type the
   fleet uses is covered. (`ping` is Rust-only: Node's own list omits the
   type it nevertheless runs.)
4. **Tags.** Out of scope in v1; the Rust returns `tags: []`. The
   production status page has `show_tags = 0`, so nothing renders
   differently; tag data stays in the old database.
5. **Cert expiry fields** (`certExpiryDaysRemaining`, `validCert`) and
   group `sendUrl`: not part of the v1 surface.

## Golden-path checklist (manual, on staging)

Run after the parity script, before cutover, with both stacks up (Node on
3001, Rust on 3101 via `docker/RUST-CUTOVER.md`):

- [ ] **Dashboard loads** on the Rust origin; monitor table shows the same
      fleet, statuses, uptimes and pings as the Node origin side by side.
- [ ] **Monitor detail**: heartbeats bar matches, ping history renders,
      edit form prefills (including the ping fields) and a save round-trips.
- [ ] **Live updates**: with the dashboard open, a monitor transition
      (pause/resume or a test push with `status=down`) moves the row
      without a refresh; `GET /api/v1/events` stays connected (no
      reconnect loop).
- [ ] **Superboard**: cards render live metrics for the agent hosts; a
      host with no sample shows as unknown rather than broken.
- [ ] **Agents panel**: list, mint, disable, revoke; the minted token
      works with `curl -H "Authorization: Bearer <token>" .../api/v1/health`.
- [ ] **Status page** `/status/clients`: password prompt appears; unlock
      succeeds; groups, monitor rows, uptimes and the page badge match the
      Node rendering.
- [ ] **Badges**: embed `…/api/badge/<id>/status`, `/uptime/24h`,
      `/ping/24h` in a browser tab and compare against the Node origin.
- [ ] **Agent push**: let the office Go agent push to the staging origin
      for a minute (temporary config change) and confirm heartbeats and
      metrics land; revert the config.
- [ ] **Telegram**: with notifications re-enabled in the staging copy,
      push `?status=down` to a test monitor and confirm one message, then
      push up and confirm recovery.
- [ ] **SSE caps**: open two dashboard tabs; both stream without hitting
      the per-token stream limit.
