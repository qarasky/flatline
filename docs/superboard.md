# Superboard

The wall board: one card per server that pushes telemetry, sized and coloured to
be read from across the room. It is a route in the dashboard app, not a separate
application.

| Route               | Chrome                 | Use                 |
| ------------------- | ---------------------- | ------------------- |
| `/superboard`       | Header with navigation | Desk use and setup. |
| `/superboard/kiosk` | None, fixed viewport   | The wall monitor.   |

Both accept a comma-separated group scope: `/superboard/kiosk/work`,
`/superboard/kiosk/work,personal`. Scopes match a monitor group by slug
(`Aiel Qorgan` → `aiel-qorgan`) or case-insensitive exact name; only
`type: "group"` monitors match, and an unknown scope shows nothing rather than
everything. Without a scope the board shows every server.

## Which monitors appear

A card is any monitor with a recent telemetry sample. Groups are never cards
(the board lists monitors, skips `type: "group"`, and asks for `metrics/latest`
for the rest; a 404 means "not a server" and is dropped). A host that stops
pushing ages out by itself, so no configuration decides membership.

Order follows the monitor tree: parent group `weight`, then the monitor's own
`weight`, then name, so the board never reshuffles between refreshes.

## Card anatomy

```
┌───────────────────────────────────────────────────────────────┐
│ ⬢ web-01 ↗                            ● Host up               │
│   uptime 11d · agent 1.8.1            Updated 2s ago          │
│                                                               │
│ Security Updates: 6 · reboot required      ← flags line       │
│                                                               │
│ CPU 48°C                                                      │
│   [33][27][35][19][ ][ ][ ][ ]            ← per-core squares  │
│   Peak 10m 34% · load 0.42                                    │
│                                                               │
│ RAM 9.5 / 64 (GB)                                             │
│ ▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                     │
│                                                               │
│ DISK 210 / 512 (GB)                                           │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░                     │
│                                                               │
│ CONTAINERS                                    2/2 running     │
│ ● app        34% · 1.6G                                       │
│ ● nginx       6% · 120M                                       │
│                                                               │
│ WEBSITES                                      1 down · 1/2 up │
│ ● api.clients.kz   ● shop.clients.kz                          │
└───────────────────────────────────────────────────────────────┘
```

- **Title** is the monitor's display name (renamable from the board); the agent's
  reported hostname stays read-only and appears in the tooltip. `↗` opens the
  history dialog.
- **Subline** is uptime and agent version — nothing else. OS and core count are
  noise the operator can get from the machine.
- **Status pill**: `Host up`, `Host down`, `Pending`, `Maintenance`, or a
  website-derived headline (`1 website down`, `2 websites pending`) when the
  hosted sites are in worse shape than the host. Freshness sits beside it
  (“Updated 2s ago”, or amber “Stale · 4m ago”).
- **Flags line** carries the update status and the agent warning, side by side.
- **CPU**: per-core squares with the load printed inside each, the package
  temperature in the label, and a `Peak 10m` line with the load average.
- **RAM** and **Disk** are each one full-width row: label, `used / total` figure
  on the line, slim bar underneath. Disk shows the fullest mount.
- **Containers** and **Websites** sections appear only when they have something
  to say.

Squares, not just colours: every bar and chip carries a number or a symbol so the
board does not depend on colour alone.

### Attention and freshness

Attention is expressed by the card's 1px border and the headline, never by a
thicker accent — a troubled card must not be heavier than its neighbours.

| Attention           | When                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bad (red border)    | Host down, or a linked website is down.                                                                                            |
| Warn (amber border) | Stale data, container issues, sustained high usage (≥90% on any of CPU/RAM/disk/GPU), pending status, or a linked website pending. |
| Normal              | Healthy.                                                                                                                           |

Freshness is separate from reachability: a sample is stale after
`max(5s, sampleInterval × 3)` when the agent reports its interval, otherwise
after the monitor's own interval. A stale card keeps its last readable numbers
with an amber warning rather than blanking out.

### Updates line

Read-only, from the agent's package-manager checks:

| Label                                | Meaning                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `No updates` (green)                 | Report is known and zero.                                                   |
| `Updates: N` (grey)                  | Fewer than 50 pending.                                                      |
| `Updates: N` (amber)                 | 50 or more pending.                                                         |
| `Security Updates: N` (red)          | At least one security advisory.                                             |
| `… · reboot required` (flashing red) | The host must restart to finish applying updates; this outranks the counts. |

An absent field means unknown (unsupported distribution, failed check) and
renders nothing — a blind agent never reads as fully updated.

### Agent warnings

One amber line summarises what the agent reports about itself: dropped samples,
failed pushes and non-docker per-collector errors, with per-collector detail in
the tooltip. Docker collector failures are shown once, in the containers
section, instead of twice.

Right-clicking a card offers **Clear agent warnings (N)**, which acknowledges
the current counters so the line disappears. Only failures past the
acknowledged point bring it back; an agent restart drops the acknowledgements
rather than hiding new ones. The count in the menu is the same count the line
prints.

### Provider logos

A monitor's `provider` id (usually a domain, e.g. `hetzner`, `ps.kz`) draws that
provider's symbol before the title: transparent, no badge, sized with the title
text. Bundled logos live in `apps/dashboard/public/providers/` and are listed in
`apps/dashboard/src/lib/providers.ts`; a provider the catalogue does not know but
that looks like a domain falls back to that site's favicon, so adding a provider
is an edit rather than a release. Unknown slugs draw nothing, and a favicon that
cannot load (offline kiosk) collapses to no logo instead of a broken image.

## Containers

At most two rows, one container each, so the full name is never truncated.
Failing containers always fill the rows first; when nothing is failing, the two
busiest running containers take them (CPU first, memory as the tie-break).
Stopped containers are not listed — without an expected-running policy they
express intent, not failure, and would crowd out live signal.

The right side of a row carries the failing state (`running · unhealthy`,
`restarting`, `dead`) or, for a healthy row, the live CPU/memory reading. When
the agent cannot reach Docker at all, the section stays and says so, with how
old the last successful collection is. A card with no running containers and no
error shows no container section at all.

## Hosted websites

A server can be linked to the websites it hosts; they render as status chips,
worst-first, and their trouble degrades the card (a down website gives the card
a red border and a headline naming it).

Right-click → **Manage websites…** opens a searchable picker. Only HTTP/HTTPS
monitors are offered — never other servers or ping checks — and a group is
offered only when it actually contains a website somewhere below it. Linking a
group links every website inside it, including ones added later, so the chips
stay current without re-linking.

## History dialog

Selecting a server name opens a keyboard-accessible dialog (Escape closes it;
kiosk rotation pauses while it is open). Ranges are 10m, 1h, 6h, 24h, 7d, 30d
and 1y, with mean, peak and p90/p95/p99 summaries. Percentiles come from
archived readings (normally every 30 s), not from downsampled chart averages or
raw 1 Hz samples; missing readings are gaps, never zeroes. Only the open dialog
refreshes while it is open, and the live board keeps updating independently.

## Metric threshold alerts

Per-server CPU, RAM and disk thresholds, configured in the monitor edit form
(Advanced → Metric alert thresholds) or over the API. Alert-only: they never
flip a monitor's status or write heartbeat rows, so the host-down path stays the
only thing that can take a monitor down.

- Fires when the value stays at or above the threshold for 60 seconds.
- Recovery is declared at threshold − 5 points (hysteresis), and the hysteresis
  band itself is silent rather than printing “88% ≥ 90%”.
- While still breached, it repeats at most every 30 minutes.
- Maintenance and paused states do not suppress evaluation, but a suppressed
  episode never sends a lone recovery message.
- Disk alerts name the fullest mount; evaluation uses receive time, so a
  backfilled backlog cannot replay old alert timelines.

State is in-process and bounded; an agent or backend restart may re-send one
alert after the debounce.

## Auto-pagination and parameters

Page size is measured from the viewport against a 340×420 minimum card, with a
floor of ten hosts so a tall card cannot shrink the fleet to one row per page.
Small fleets stay on one page instead of rotating.

| Query parameter | Default  | Meaning                                                                                                                            |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rotate`        | `5`      | Seconds between pages (1–300). Rotation pauses on any interaction and resumes after 30 s idle, and pauses while the tab is hidden. |
| `perPage`       | measured | Explicit page size override.                                                                                                       |

A kiosk with no session shows a QR code to sign in with a phone; see
[Signing in](dashboard.md#signing-in).

Kiosk mode is chrome-free and hides scrollbars. Reaching it is a route, not a
parameter.

## Not shown on the card

- **GPU tiles.** The tile code is intact and gated behind a flag; the data is
  collected and stored.
- **Network and disk I/O throughput.** Collected, derived and stored (as the
  basis for future traffic statistics), but the card deliberately keeps to CPU,
  RAM and disk.
