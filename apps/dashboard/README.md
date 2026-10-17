# Flatline operator dashboard

Vite + React dashboard for the API-only Flatline backend. Operators share
monitors but have separate credentials and API tokens.

## Local development

The repository's `./dev.sh` starts the complete stack (Rust backend, Go agent
and mock fleet, this dev server). To run this app alone:

```sh
npm --prefix apps/dashboard ci
FLATLINE_DEV_BACKEND=http://127.0.0.1:3001 npm --prefix apps/dashboard run dev
```

Run commands from the repository root; Node is needed only for Vite. The dev
server defaults to port 3003 and proxies `/api` and `/agent` to the backend
(see `vite.config.ts`), so the browser sees one same-origin API exactly as it
does in production — where the backend serves this build itself.

## Main views

- `/`: searchable grouped monitors, bulk operations, detail panels and Agents.
- `/status/:slug`: public client status pages (no operator token involved).
  On host-mapped client domains the site root resolves the slug from the
  request host instead. Password-gated pages show the unlock form; the page
  refreshes every 30s while visible.
- `/superboard`: live host metrics and compact container rows.
- `/superboard/kiosk`: wall-display chrome, clock and automatic fleet pagination.
- `/superboard/kiosk/<group>`: the same board scoped to a monitor group —
  `/superboard/kiosk/work` shows only that group's children, comma-separated
  scopes combine groups, and unfiltered URLs show the whole fleet. Matching is
  by slug (`Aiel Qorgan` → `aiel-qorgan`) or case-insensitive exact name;
  unknown scopes show an empty board rather than everything.

Sign in with the operator token — the one the server writes to
`initial-token.txt` on first boot, or any token minted in the Agents panel.
There are no accounts, invites or one-time codes. REST snapshots and
bearer-authenticated SSE keep
views current. Up to ten hosts remain on one default fleet page; smaller
viewports scroll the board rather than rotating single rows.

Select a server name (↗) for history. Ranges span 10m to 1y, with p90/p95/p99
computed from archived readings: raw 30s snapshots up to 7 days, hourly
rollups (min/max/avg, two-year retention) beyond, where peak stays the true
maximum. History refreshes every 30 seconds and pauses
fleet pagination while open; Escape closes the dialog.

Right-click a server card for the custom menu; **Rename** edits the monitor's
display name (card titles prefer it over the agent hostname). Needs a
write-scoped token; a read-only token gets an explicit refusal. The name
change propagates to every connected board through the server's invalidate
broadcast. Rotation pauses while the menu or dialog is open.

Cards show pending-update counts when the agent reports them: `No updates`
green, `Updates: N` yellow below 50 / red at 50+, `Security Updates: N` dark
red. A missing field means unknown and renders nothing.

Agent 1.4+ payloads carry a self-report: the header line shows the agent
version (tooltip: version + process uptime) and a card prints one amber
`Agent: …` warning line when there are dropped samples, failed pushes, or
non-docker collector errors, with the full detail (per-collector counts, last
push error) in the tooltip. Docker collector failures keep their existing
single line in the containers section instead.

The monitor edit form (Advanced → Metric alert thresholds) configures
per-server CPU/RAM/disk percentage thresholds. Evaluation is server-side at
ingest: 60-second debounce, 30-minute cooldown while sustained, recovery
declared 5 points below the threshold, and messages sent through the
monitor's linked notifications. Clearing a field disables that alert. No
agent upgrade is needed — thresholds read the metrics the server already
has.

Cards show load average next to `Peak 10m` (tooltip: 1/5/15) and a
`Net ↓ ↑ · I/O R W` line in the resources section when the agent reports
counters; rates are derived server-side over the window between pushes, and
gaps simply hide the line.

SMART disk health speaks only when there is trouble: a red `SMART <dev>:
failing` line or an amber `SSD wear N%` warning at 80% or above, with
per-disk detail (health, temperature, reallocated sectors, power-on time)
in the tooltip. Healthy disks render nothing; agents without smartctl
report `available: false` and are distinguishable from healthy ones.

Container tiles use three columns and roughly nine visible slots. More than
nine containers loop vertically; up to six problems are pinned. Tiles show a
compact `CPU · memory` reading when the agent reports stats (Docker's
per-core CPU convention; tooltip carries the full detail). Hover/focus
pauses motion and reduced-motion preferences disable animation. Red means a
known failure, yellow a transition/unknown state, green running/healthy, and
black exited/removed with unknown stop intent. Symbols and tooltips supplement
color. Container uptime is intentionally omitted; no manual list scrollbars.

Cards show the hosting provider's symbol before the title when a monitor has
one: a bundled transparent logo for the providers in
`src/lib/providers.ts` (PS.kz, Hoster.kz, Hetzner, DigitalOcean), or the
site's favicon for any other domain. Set it as **Provider** in the monitor
edit form — the select offers the catalog plus an **Other…** box for a
domain. No provider set means no logo, and an unknown slug draws nothing.

## Verify

```sh
npm --prefix apps/dashboard run build
node --test apps/dashboard/test/*.test.mjs
```

See [the Superboard specification](../../SUPERBOARD-SPEC.md) for archival,
peak-recovery, streaming and pagination limits, and [screenshot instructions](../../docs/screenshots/README.md)
for safe fictional-data captures.
