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

Agent 1.2 defaults to 1Hz live pushes carrying 30-second-average CPU (from
cumulative `/proc/stat` counters) with 1-second-fresh RAM. GPU refreshes every
5s, Docker every 10s, disk/temperatures every 30s. Slow collectors cannot block
fast sampling. Failed sends back off with only the newest sample queued.
A one-second 95% spike reports ~3%, not 95%.

Existing installs keep their explicit interval. To enable 1Hz, upgrade the
**backend first**, set `interval_seconds` to `1` in the existing config, then
restart `superboard`. Older backends accept the additive payload but persist
every push—do not send them high-frequency telemetry.

Keep the monitor timeout at least 3× the sample interval. A **30–180s host
timeout** is usually more useful than a 3s timeout: missed seconds show as stale
telemetry without immediately generating host-down alerts. Fast telemetry
records ordinary healthy heartbeats at most every min(30s, timeout/3).

`superboard check --verbose` performs a complete one-shot collection and push.

The dashboard now provides CPU/RAM/GPU/VRAM history charts and p90/p95/p99
summaries from archived readings. Card `Peak 10m` tracks rolling total CPU load;
neither feature requires a newer agent. Container tiles show names and state
colors, looping automatically when more than nine containers are present.

Network counters, Docker event subscriptions and host pending-update checks
are not implemented. Update checks are documented as a future read-only
feature; the agent does not install packages or reboot hosts. See
[`../SUPERBOARD-SPEC.md`](../SUPERBOARD-SPEC.md) for storage/stream semantics,
limits and planned update-check behavior.
