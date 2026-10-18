# Flatline host agent (`superboard`)

The host agent is a single Go binary that runs on each monitored machine,
sampling the host every second and pushing the samples, plus a self-report, to
one Flatline push monitor over HTTP. It is the only component a monitored host
runs; see [architecture](architecture.md) for its place beside the Rust backend
and dashboard, and [superboard](superboard.md) for the card it feeds.

## Design constraints

- **One static binary.** `CGO_ENABLED=0`, shipped as `superboard-linux-<arch>`
  for `amd64`/`arm64`; no runtime, no interpreter.
- **Push-only, outbound.** Outbound HTTPS, no listening port, no firewall rule;
  works behind NAT, on a laptop, on a home router.
- **Per-monitor push token.** Each host carries its own monitor's push token, a
  bearer secret that routes the samples and gates self-update downloads. There
  is no fleet-wide agent credential.
- **Silence is the alert.** The agent has no "host down" concept; if pushes
  stop, the server's push-timeout path on that monitor goes down.
- **Telemetry must not kill telemetry.** Collectors degrade to an explicit
  unknown, never a fatal error; a collector panic is recovered and counted.

Configuration is one URL and one token; everything else defaults.

## Install

### The served one-liner

The server serves an installer with a download credential already substituted:

```sh
curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- \
    --server <origin> --token <PUSH_TOKEN>          # fresh install

curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update
```

It requires root, picks `amd64`/`arm64` from `uname -m`, downloads
`superboard-linux-<arch>` and `sha256sums`, and verifies the SHA-256 first.
Flags: `--server`, `--token`, `--interval SECONDS`, `--update`.

### What a fresh install writes

`superboard install` (root) creates:

| Path                                     | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `/usr/local/bin/superboard`              | The agent binary (mode 0755).                                    |
| `/etc/superboard/config.json`            | Configuration, **mode 0600** (owner-only; holds the push token). |
| `/etc/systemd/system/superboard.service` | The `superboard` systemd unit.                                   |
| `/usr/local/bin/superboard.bak`          | Copy of any binary that was replaced.                            |
| `/var/lib/superboard/buffer`             | Disk buffer for undelivered samples (mode 0700).                 |

The unit runs `superboard run --config /etc/superboard/config.json` as
`User=root` (the Docker socket is root-owned; the agent only reads it), with
`Type=simple`, `Restart=always`, `RestartSec=10`, ordered after
`network-online.target` and `docker.service`. One agent per box, a predictable
service name to grep for.

### systemd, and the cron fallback

`install` checks PID 1 is systemd via `/run/systemd/system` (the `systemctl`
binary alone is not enough: containers ship it without running it as init). With
systemd it writes the unit, enables and starts it; without it, it adds one
crontab entry:

```
@reboot /usr/local/bin/superboard run --config /etc/superboard/config.json # superboard-agent
```

and starts an agent now so the operator need not wait for a reboot. It prints
the limitation rather than hiding it: **cron cannot supervise** — an agent that
dies mid-day stays dead until reboot. `uninstall` removes exactly the tagged
line.

### Updating an existing install

`install.sh --update` keeps the config and push token, copies the current binary
to `superboard.bak`, moves the new one into `/usr/local/bin/superboard`, and
restarts. On systemd hosts it is the manual fallback for what the agent cannot
do itself (see [Self-update](#self-update-agent-17)). Fleet provisioning is in
the [provisioning runbook](provisioning.md).

## Configuration

`/etc/superboard/config.json`; only `server_url` and `push_token` are required.
`run` reads it, `install` writes it.

| Key                           | Default                      | Meaning                                                                                                                 |
| ----------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `server_url`                  | — (required)                 | Flatline origin, e.g. `https://uptime.example`. Plain `http://` is refused unless `allow_insecure`.                     |
| `push_token`                  | — (required)                 | The monitor's push token. Bearer secret: keep the file 0600. Rotation is one server-side regenerate plus one line here. |
| `interval_seconds`            | `1`                          | Seconds between live samples. An explicitly configured interval is preserved on upgrade.                                |
| `allow_insecure`              | `false`                      | Permit plain HTTP. Off by default because metrics (hostnames, container names, versions) are useful recon in cleartext. |
| `buffer_dir`                  | `/var/lib/superboard/buffer` | Disk-backed queue for undelivered samples. Holds hostnames and container names: keep it 0700, root-owned.               |
| `buffer_max_bytes`            | `33554432` (32 MiB)          | Byte cap on the buffer. Oldest samples are dropped first when full, so an endless outage cannot fill the disk.          |
| `self_update`                 | `true`                       | Let the agent replace its own binary from a server-shipped release. Set `false` on a host you update by hand.           |
| `self_update_interval_hours`  | `24`                         | How often the agent asks the server for a newer release.                                                                |
| `self_update_allow_downgrade` | `false`                      | Permit installing an older release, for recovering a bad rollout without host access.                                   |

## Collectors

Fast values (RAM, load, net/disk I/O counters, the raw CPU snapshot) are read
every sample; expensive sources refresh in background workers on their own
schedule and are cached until then, so a slow source never blocks the push loop.

| Collected                            | Source                                               | Cadence                               | Failure surfaced as                                                          |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Host identity (hostname, OS, uptime) | `host.Info`                                          | Once at startup                       | Fatal only if the host cannot be identified at all.                          |
| CPU utilization                      | Cumulative `/proc/stat` counters, diffed over 30s    | Every push (value), refresh every 30s | Counters omitted → server falls back to compat percent; `cpu` error counted. |
| CPU temperature                      | hwmon sensors (`coretemp`, `k10temp`, `zenpower`, …) | Every 30s                             | Hidden when zero ("no sensor").                                              |
| RAM                                  | `mem.VirtualMemory`                                  | Every sample (~1s)                    | The one sample-fatal read.                                                   |
| Memory temperature                   | hwmon (`dimm`, `ddr`, `memory`)                      | Every 30s                             | Hidden when zero.                                                            |
| Disks (per mount)                    | `disk.Partitions`/`Usage`, pseudo-fs skipped         | Every 30s                             | Unreadable mount skipped and logged; empty list means "cannot read mounts".  |
| Disk I/O                             | Cumulative per-disk counters, whole disks only       | Every push                            | `diskio` error counted; field omitted.                                       |
| Network I/O                          | Cumulative per-interface counters, loopback excluded | Every push                            | `net` error counted; field omitted.                                          |
| Load average                         | `load.Avg` (gauge, no delta)                         | Every push                            | `load` error counted; field omitted.                                         |
| Docker containers + one-shot stats   | Docker Unix socket (`docker ps` fallback)            | Every 10s                             | Keeps last list and reports `dockerError` + `dockerAt`.                      |
| Pending OS updates                   | apt / dnf / yum / pacman / apk, read-only            | Every 4h                              | Field omitted (unknown); `updates` error counted.                            |
| GPU                                  | `nvidia-smi` CSV                                     | Every 5s                              | `gpu.available:false`; backoff after 3 consecutive failures.                 |
| SMART disk health                    | `smartctl -j -H -A`                                  | Every 6h                              | `smart.available:false` or skipped device; `smart` error counted.            |

Failure policy is consistent:

- **Explicit, never absent.** A missing GPU reports `gpu.available:false`; no
  readable disk reports `smart.available:false`. An empty list is not null.
- **Docker is the exception.** An empty container list is ambiguous (none vs.
  cannot see the daemon), so a failed pass attaches `dockerError` and reuses the
  previous list with `dockerAt` at the last complete collection: the board shows
  "unavailable" or "containers as of Xm ago", never stale health as current.
- **Episodes, not ticks.** `collectorErrors` counts the first failure after a
  healthy period, so a permanently broken collector contributes one, not one per
  second; the count rises again only after recovery and a new failure.
- **Never fatal.** Collectors log, degrade, and return; a panicking collector
  goroutine is recovered and counted. GPU and Docker back off while broken.

The Docker pass is bounded to 20s with four workers, tries `DOCKER_HOST` (unix
only), `/var/run/docker.sock` and rootless socket paths in order, then falls
back to `docker ps`; the agent only reads, never manipulating containers.

`superboard/mockagent` fabricates a demo fleet (healthy, hot, neglected,
security-pending, GPU, blind-Docker, quiet, many-core) through the public API for
local UI work — a development tool, not part of a deployment.

## The pushed payload

A live push is an HTTPS `POST` to `<origin>/api/push/<token>` (with
`?telemetry=1` once a sample interval is set) whose body is
`{"status":"up","msg":"OK","metrics":{…}}`. Unknown fields are ignored
server-side; the envelope's `v` (currently `1`) is bumped only when a field
changes shape.

```json
{
  "v": 1,
  "sampleInterval": 1,
  "sampledAt": "2026-10-18T09:00:00.000Z",
  "host": { "hostname": "web-01", "os": "linux", "uptime": 518400 },
  "cpu": {
    "percent": 12.4,
    "cores": 8,
    "perCore": [12, 9, 15, 8],
    "temp": 46,
    "counters": {
      "total": 123456789,
      "idle": 100000000,
      "perCore": [{ "total": 15432098, "idle": 12500000 }]
    }
  },
  "mem": { "total": 68719476736, "used": 12884901888, "percent": 18.8 },
  "disk": [{ "mount": "/", "total": 549755813888, "used": 225485783040, "percent": 41 }],
  "gpu": { "available": false },
  "docker": [
    {
      "name": "api",
      "image": "ghcr.io/acme/api:1.6.2",
      "state": "running",
      "health": "healthy",
      "ports": ["8080:80"],
      "uptime": 432000,
      "stats": {
        "cpuPercent": 22.0,
        "memUsed": 943718400,
        "memLimit": 2147483648,
        "memPercent": 43.9
      }
    }
  ],
  "dockerError": "no docker access (…)",
  "dockerAt": "2026-10-18T08:59:57Z",
  "updates": { "total": 41, "security": 6, "rebootRequired": true },
  "agent": {
    "version": "1.7.0",
    "uptime": 86400,
    "samplesDropped": 4,
    "failedPushes": 3,
    "lastError": "connect: connection timed out",
    "collectorErrors": { "gpu": 2 }
  },
  "load": { "avg1": 0.42, "avg5": 0.51, "avg15": 0.6 },
  "net": [{ "iface": "eth0", "rxBytes": 193273528320, "txBytes": 96636764160 }],
  "diskIo": [{ "device": "sda", "readBytes": 687194767360, "writeBytes": 236223201280 }],
  "smart": {
    "available": true,
    "disks": [
      {
        "device": "sda",
        "health": "passed",
        "tempC": 34,
        "reallocatedSectors": 0,
        "powerOnHours": 20000
      }
    ]
  }
}
```

**Units.** Memory and disk totals are **bytes**, percentages **0–100**, uptimes
**seconds**; CPU counters are cumulative **USER_HZ ticks**, network and disk I/O
cumulative **bytes**, load a unitless gauge. Container CPU follows Docker's
convention (percent of one core: four cores reads `400`). Multi-valued fields
are ordered, lossless lists — the server decides what to sum or show.

**Semantics that matter.**

- **Raw CPU counters.** `cpu.counters` (box total, idle, one pair per logical
  CPU) rides every push; the server derives percent and per-core by diffing
  consecutive snapshots, falling back to `cpu.percent`/`cpu.perCore` only with
  no previous snapshot, reset counters, or out-of-order samples. The agent's own
  percent is a 30s interval mean.
- **`sampledAt`.** True collection time (RFC3339, ms, UTC); the server validates
  it and falls back to receive time. It lets a backlog drained after an outage
  archive at its real cadence; the server stays the clock authority.
- **`dockerError` / `dockerAt`.** Why a container collection failed, and when
  the last _complete_ one ran — a stale list looks old rather than current.
- **`updates` / `rebootRequired`.** Absent means unknown (no board display);
  `total: 0` means fully updated. `security` exists only where the platform
  exposes severity. `rebootRequired` is orthogonal and is the loudest state — no
  package check clears a staged kernel.
- **`agent` self-report.** Version, process uptime, `samplesDropped`,
  `failedPushes`, `lastError`, nonzero `collectorErrors`. `failedPushes` counts
  samples delivery _lost_, not retried attempts, so a recovered blip only sets
  `lastError`; counts reset on restart, so tiny `uptime` means a crash loop.
- **`net` / `diskIo`.** Raw cumulative counters, not rates. `net` excludes
  loopback and keeps virtual interfaces (the server excludes them when summing
  card throughput); `diskIo` covers whole disks only, partitions filtered. The
  server-derived `netRate`/`diskIoRate` appear only on live samples; history
  keeps the raw counters.
- **`smart`.** Best-effort: `available:false` is explicit, `health` is
  `passed`/`failed`, counters are omitted when unknown rather than zero-filled.
  `wearPercent` is NVMe `percentage_used` only — ATA wear means "remaining" on
  some vendors and "used" on others, so it is not guessed.

Server-side token and payload handling is in [api](api.md).

## Delivery

Sample every `interval_seconds` (default 1) and push through a **disk-backed,
bounded FIFO** at `buffer_dir`:

- Atomic writes (temp + rename), 0600 in a 0700 directory, until accepted;
  backend outages and restarts become late history, not missing history, and a
  prior run's pending samples are recovered at startup.
- **Oldest-first drain** at ~20 pushes/s (a 50ms gap while backlogged) keeps
  counter-window and backfill math chronological and avoids hammering the
  backend on reconnect.
- Capped by `buffer_max_bytes`; when full the **oldest** samples are evicted and
  counted in `samplesDropped`, so an endless outage cannot fill the disk.
- If the directory is unusable, the agent falls back to an in-memory newest-wins
  queue of one sample (each replacement a drop) and logs it; buffering is an
  upgrade, never a requirement.

Failures are classified, because retrying the wrong kind wedges a queue:

| Server answer      | Meaning                                                            | Agent response                                                                                                             |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 400, 413           | Server understood and refused the payload; retry fails identically | **Quarantine** under `buffer/quarantine/` (newest 20 kept) and count it lost; the queue keeps draining.                    |
| 401, 403, 404      | Auth/config problem (unknown or inactive token)                    | Keep the backlog and keep sampling; fix the token and the accumulated history delivers. Logged at most once per 5 minutes. |
| 5xx, network error | Transient                                                          | Retry the same sample with jittered exponential backoff capped at 30s.                                                     |

**Silence is the signal.** A failed push is never reported locally as
host-down; the server turns sustained silence into a down state via the
monitor's push timeout. A 400 means "fix the collector", not "the host is down":
the heartbeat is still recorded.

**Interval relationship.** A push monitor's check interval (timeout) must be
**≥ 3× `interval_seconds`** — with the 1s default, 3s or more, and 30–180s is
usually more useful so missed seconds surface as stale telemetry before they
become a down alert. Slow collector cadences (Docker 10s, disk 30s, updates 4h,
SMART 6h) are independent of it.

## Self-update (agent 1.7+)

An update needing a human per host is a fleet of stale root daemons, so the
agent keeps itself current by default.

- **Trigger.** Two minutes after startup (staggered so a fleet rebooted together
  does not stampede), then every `self_update_interval_hours` (default 24), the
  agent asks the server what it ships.
- **Token-gated manifest.** `GET /agent/version?token=<push_token>`. Only a
  provisioned host has a token, so that endpoint is the fleet whitelist and
  self-update needs no extra credential.
- **Download and verify.** If the server's version is newer, the platform build
  (`<goos>-<goarch>`) is fetched from the agent's own origin
  (`/agent/<file>?token=…`, not a manifest URL) with its **SHA-256 verified**.
  HTTPS is required; plain HTTP is refused unless `allow_insecure` (dev only).
- **Staged-binary check.** The download must run and report the expected
  version; a truncated or wrong-architecture binary is discarded.
- **Detached swap.** A helper — a copy of the _current_ binary, so it survives
  replacement — is detached with `setsid`, swaps the binary in, and keeps the
  previous build at `/usr/local/bin/superboard.bak`.
- **Health window and rollback.** It restarts the service and waits up to **45s**
  for it to become active; if it does not, `.bak` is restored and restarted, so
  a bad release rolls back instead of bricking a box.
- **Downgrades** are refused unless `self_update_allow_downgrade` is true;
  prerelease suffixes compare equal to the release.
- **Requirements.** systemd is required: without it the agent cannot restart
  itself and only logs the available release — use `install.sh --update` there.

Failures never touch telemetry: the check runs beside the push loop and errors
are logged and retried at the next interval.

**Agents older than 1.7 need one manual hop.** They have no self-update code, so
`install.sh --update` (or a manual `install`) must run once per host; after that
they update themselves. This is the one point where the fleet cannot be updated
by the fleet.

## Commands

| Command                                                                                        | Purpose                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superboard version`                                                                           | Print the version (e.g. `superboard 1.7.0`). Release builds stamp it via `-ldflags`.                                                                          |
| `superboard check [--verbose]`                                                                 | Collect and push **once**, print the outcome, exit 0 on accept. `--verbose` prints the full payload. A fast diagnostic (1s CPU window), never a load average. |
| `superboard install --server URL --token TOKEN [--interval SECS] [--insecure] [--config PATH]` | Write config, install the service, and start it. Must run as root; refuses to double-install.                                                                 |
| `superboard uninstall [--config PATH]`                                                         | Stop and remove everything install created: service (or cron entry), buffer directory, and config. Must run as root.                                          |
| `superboard self-update [--check]`                                                             | Apply a server-shipped release immediately. `--check` only reports what would happen and installs nothing.                                                    |
| `superboard run [--config PATH]`                                                               | Collect and push forever; this is what the service runs. Not normally invoked by hand.                                                                        |

A hidden `apply-update` entry point is used by the detached swap helper, not by
operators.

## Troubleshooting

| Symptom                                                      | Likely cause                                                                                                                              | What to do                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host card stays pending, no telemetry                        | Wrong `push_token`/`server_url`, agent not running, or no outbound HTTPS                                                                  | `superboard check --verbose` as root; inspect `/etc/superboard/config.json`; check the unit (`systemctl status superboard`) or the `@reboot` cron line. A 404 means the token is unknown or inactive.      |
| Monitor flips down while the host is fine                    | Push interval too close to the monitor timeout, or transient push failures                                                                | Keep the check interval ≥ 3× `interval_seconds` (30–180s is typical). Check `agent.lastError`/`failedPushes` on the card: sustained failure is the server's silence path firing.                           |
| Install fails at checksum verification                       | Truncated download, a proxy rewriting bytes, or a mismatched `sha256sums`                                                                 | Rerun the one-liner (the installer retries three times); confirm the origin serves the matching `sha256sums` and that nothing rewrites the response.                                                       |
| `self-update` reports success but the version did not change | No build for this platform, a downgrade with `self_update_allow_downgrade` false, no systemd, or a health-window rollback restored `.bak` | Run `superboard self-update --check` to see what the server ships; check the `self_update*` keys; on non-systemd hosts use `install.sh --update`; inspect `apply.log` under `/var/lib/superboard/update/`. |
| Push returns 401/403/404                                     | Token missing, inactive, or rotated and not updated on the host                                                                           | Regenerate the monitor's push token server-side, update `push_token` in `/etc/superboard/config.json`, and restart the agent. The backlog is kept while the token is wrong and delivers once it is fixed.  |
| `docker` shows unavailable, not "no containers"              | No reachable socket (permission, rootless path, exotic `DOCKER_HOST`)                                                                     | Check `dockerError` on the card; confirm the agent can read a Docker socket or that the `docker` CLI is on `PATH`. The agent only reads the socket.                                                        |
| Agent uptime is tiny on a long-running host                  | Crash loop                                                                                                                                | Check the journal for `collector panic` or a config error; the self-report's `lastError` and `collectorErrors` name the failing collector.                                                                 |

Deployment topologies and the served installer are in
[deployment](deployment.md); the surrounding architecture and API are in
[architecture](architecture.md) and [api](api.md).
