# Flatline operator dashboard

Vite + React dashboard for the API-only Flatline backend. Operators share
monitors but have separate credentials and API tokens.

## Local development

The repository's `./dev.sh` starts the complete stack. To run this app alone:

```sh
npm --prefix apps/dashboard ci
VITE_FLATLINE_URL=http://127.0.0.1:3001 npm --prefix apps/dashboard run dev
```

Run commands from the repository root. Node.js >=26.2 is required. The Vite
development server defaults to port 3003; the backend must already be running.
Set the backend address to one reachable by the browser. Production containers
replace the backend URL placeholder at startup via `FLATLINE_URL`.

## Main views

- `/`: searchable grouped monitors, bulk operations, detail panels, Agents and Users.
- `/superboard`: live host metrics and compact container tiles.
- `/superboard/kiosk`: wall-display chrome, clock and automatic fleet pagination.
- `/superboard/kiosk/<group>`: the same board scoped to a monitor group —
  `/superboard/kiosk/work` shows only that group's children, comma-separated
  scopes combine groups, and unfiltered URLs show the whole fleet. Matching is
  by slug (`Aiel Qorgan` → `aiel-qorgan`) or case-insensitive exact name;
  unknown scopes show an empty board rather than everything.

Sign in with username/password (and TOTP when configured); first-run setup
creates the initial account. REST snapshots and bearer-authenticated SSE keep
views current. Up to ten hosts remain on one default fleet page; smaller
viewports scroll the board rather than rotating single rows.

Select a server name (↗) for history. Ranges span 10m to 7d, with p90/p95/p99
computed from archived readings. History refreshes every 30 seconds and pauses
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

Container tiles use three columns and roughly nine visible slots. More than
nine containers loop vertically; up to six problems are pinned. Hover/focus
pauses motion and reduced-motion preferences disable animation. Red means a
known failure, yellow a transition/unknown state, green running/healthy, and
black exited/removed with unknown stop intent. Symbols and tooltips supplement
color. Container uptime is intentionally omitted; no manual list scrollbars.

## Verify

```sh
npm --prefix apps/dashboard run build
node --test apps/dashboard/test/*.test.mjs
```

See [the Superboard specification](../../SUPERBOARD-SPEC.md) for archival,
peak-recovery, streaming and pagination limits, and [screenshot instructions](../../docs/screenshots/README.md)
for safe fictional-data captures.
