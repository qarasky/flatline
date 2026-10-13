# Superboard agent

Build: `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o superboard .`

Put the binary somewhere persistent, such as `/usr/local/bin/superboard`.
Install as root:

```sh
sudo /usr/local/bin/superboard install --server https://flatline.example --token YOUR_PUSH_TOKEN --interval 1
```

The token is saved in `/etc/superboard/config.json` with mode 0600. systemd runs
the agent as root; non-systemd hosts get a warned, unsupervised cron `@reboot`
fallback. Do not install the service from `/tmp`.

Agent 1.5 defaults to 1Hz live pushes carrying raw cumulative CPU counters
(`/proc/stat` snapshots), network and disk I/O counters, and the load
average, with 1-second-fresh RAM; the server derives
utilization from consecutive snapshots (responsive live, ~30s means in
history), so a one-second 95% spike archives as ~3%, not 95%. The agent's
own percent fields remain as fallback for old backends. Network and disk
I/O ride as raw counters and the server derives per-second rates for the
live card only (gaps produce no rate). GPU refreshes every
5s, Docker every 10s, disk/temperatures every 30s, pending-update counts
every 4h (read-only, counts only, absent when unknown). Slow collectors
cannot block fast sampling.

Samples are delivered through a **disk-backed buffer**
(`/var/lib/superboard/buffer`, capped by `buffer_max_bytes`, default 32 MiB):
a backend outage or agent restart becomes late history instead of missing
history. The sender drains oldest-first at ~20 pushes/s; when the cap is hit
the oldest samples are dropped and counted. If the directory cannot be used
(permissions, read-only root), the agent falls back to the in-memory
newest-wins queue and logs it. Every sample carries `sampledAt`, so the
server archives a drained backlog at its real 30s cadence. `uninstall`
removes the buffer directory.

Delivery failures are classified so a poisoned entry cannot wedge the queue:
a payload the server refuses (400 for bad metrics, 413 for the body limit) is
**quarantined** under `buffer/quarantine/` (newest 20 kept) and counted as a
dropped sample, while the rest of the backlog keeps draining. A credential
or configuration answer (404 for an unknown/inactive token, 401/403) keeps
the backlog — sampling continues, the failure is logged at most once per
five minutes, and fixing the token delivers everything that accumulated.
Transient failures (network, 5xx) still retry the same sample with backoff.

Every payload carries an `agent` self-report, Telegraf-style: version,
process uptime, dropped samples, failed pushes with the last error reason,
and per-collector error counts (only nonzero entries). Cards show the agent
version and an amber warning line when something has gone wrong; a clean
agent adds no noise. Counts reset on agent restart and describe "has had
trouble since start", not necessarily "failing right now".

Existing installs keep their explicit interval. To enable 1Hz, upgrade the
**backend first**, set `interval_seconds` to `1` in the existing config, then
restart `superboard`. Older backends accept the additive payload but persist
every push—do not send them high-frequency telemetry.

Keep the monitor timeout at least 3× the sample interval. A **30–180s host
timeout** is usually more useful than a 3s timeout: missed seconds show as stale
telemetry without immediately generating host-down alerts. Fast telemetry
records ordinary healthy heartbeats at most every min(30s, timeout/3).

`superboard check --verbose` performs a complete one-shot collection and push.

The dashboard provides CPU/RAM/GPU/VRAM history charts and p90/p95/p99
summaries from archived readings. Card `Peak 10m` tracks rolling total CPU load;
neither feature requires a newer agent. Container tiles show names and state
colors, looping automatically when more than nine containers are present.
Host cards show pending-update counts (`No updates` green, `Updates: N` yellow
below 50 / red at 50+, `Security Updates: N` dark red); unknown stays blank.

Not implemented: Docker event subscriptions and log shipping. Update checks
are read-only and never install packages or reboot hosts. SMART disk health
is read-only via smartctl (every 6h; absent tool reports `available:
false`). See
[`../SUPERBOARD-SPEC.md`](../SUPERBOARD-SPEC.md) for storage/stream semantics
and limits, and [`../IMPROVEMENT-ROADMAP.md`](../IMPROVEMENT-ROADMAP.md) for
the ranked backlog.
