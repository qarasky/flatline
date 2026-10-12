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

Agent 1.4 defaults to 1Hz live pushes carrying raw cumulative CPU counters
(`/proc/stat` snapshots) with 1-second-fresh RAM; the server derives
utilization from consecutive snapshots (responsive live, ~30s means in
history), so a one-second 95% spike archives as ~3%, not 95%. The agent's
own percent fields remain as fallback for old backends. GPU refreshes every
5s, Docker every 10s, disk/temperatures every 30s, pending-update counts
every 4h (read-only, counts only, absent when unknown). Slow collectors
cannot block fast sampling. Failed sends back off with only the newest
sample queued.

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

Not implemented: network counters, Docker event subscriptions, per-container
CPU/memory stats, and log shipping. Update checks are read-only and never
install packages or reboot hosts. See
[`../SUPERBOARD-SPEC.md`](../SUPERBOARD-SPEC.md) for storage/stream semantics
and limits, and [`../IMPROVEMENT-ROADMAP.md`](../IMPROVEMENT-ROADMAP.md) for
the ranked backlog.
