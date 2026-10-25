# Backup status on Superboard cards, and backup-agent self-update

Date: 2026-10-25. Status: approved by the operator on 2026-10-25; implemented on `feature/backup-card-self-update` (plan `docs/superpowers/plans/2026-10-25-backup-card-and-self-update.md`).

## Intent

The operator watches the Superboard to know when a server needs attention.
Backups now run on client servers (two named agents, `modernization` and
`zhkh`, on the meks host, push monitor 48 `meks-zhkh`),
but nothing on the board says whether they are happening. The operator wants
to glance at a card and see that backups are happening on that server **and**
which project's backup is falling behind, so a stale project prompts them to
go and analyse the server.

They also want the backup agent to keep itself current the way the
monitoring agent (`superboard`) does, under its own version number, so the
card's backup version is the one actually running.

## Goals

1. Each Superboard card for a server with backup agents shows:
   - the backup-agent version right after the monitoring-agent version on the
     second line: `uptime 12d · agent 1.8.0 · backup 0.3.0`;
   - under `Updated Xs ago`, one line per backup agent (option C from the
     mockups, chosen by the operator):
     `modernization: last backup 3h ago`, `zhkh: last backup 2h ago`.
     A server with exactly one backup agent shows `last backup 3h ago`
     without the name. Format is `Xs/Xm/Xh/Xd ago`, ticking live like
     `Updated`.
2. The backup agent updates itself from the Flatline server, on its own
   version line (backup `0.x`, independent of the telemetry agent's `1.x`),
   **whether or not its backups are scheduled**: a host whose backup timers are
   disabled, or simply waiting for the next run, still updates.
3. The card's backup version stays current even when no backup has run, so it
   cannot come from backup runs alone.

## Non-goals

- No change to what a backup contains, when it runs, or how it is verified.
- No new Telegram alerting. Overdue/failed already alert through the agent's
  monitor; the card shows state (lines and whole-card attention).
- No per-project version display beyond what goal 1 says (see the version
  rule below).
- No backup controls on the card (no "run now", no download). The monitor
  detail page keeps those.
- Not Kore. Linking Flatline to Kore is a separate, later project.

## Anti-goals

- A card that looks healthy while one project has stopped backing up. This is
  why every project gets its own line instead of one summary line.
- An update that lands mid-backup, or a bad build that replaces a working
  binary and stays. The previous binary must survive a failed update.
- Mixing credentials: the telemetry agent's update feed (`/agent/version`,
  `/agent/{file}`) deliberately refuses backup-agent tokens and must keep
  doing so. Backup tokens stay confined to `/api/backup/v1`.
- Cards for servers without backup agents changing at all.

## Decided with the operator

- Placement: version after the agent version; one `last backup … ago` line per
  project under `Updated`, named when there is more than one (option C).
- Self-update is per server (one shared binary at
  `/usr/local/bin/flatline-backup`), on a daily check of its own, independent
  of the backup timers, and it runs while backups are disabled.
- meks gets one manual install of the first self-updating version; after that
  it updates itself. The operator approved doing that install.

## Card behaviour

**Whole-card attention (decided with the operator).** A backup line in the
warn tone (server health `overdue` or `failed`) also flags the card: its
`data-attention` becomes at least `warn` (never `bad`; a host or website being
down stays more severe), and the card counts toward the Superboard's "N need
attention" total instead of "All hosts up". The headline names it only when
nothing more severe applies, after host down, websites down, stale data and
metric issues: `Backup overdue` for one agent, `2 backups behind` for several.
`pending` and `disabled` agents never flag the card. This changes
`FleetCard`'s attention/headline logic and the board's attention count in
`Superboard.tsx`; both are covered by tests, and `docs/superboard.md` records
the new rule.

Per backup agent linked to the card's monitor (`backup_agents.monitor_id`):

The line follows the server's `health` (`runs::health_for`), never a rule
re-derived in the browser:

| Server health | Line                                                                | Tone  |
| ------------- | ------------------------------------------------------------------- | ----- |
| `healthy`     | `<name>: last backup 3h ago`                                        | quiet |
| `pending`     | `<name>: no backup yet` (new agent, under 36 h old)                 | quiet |
| `overdue`     | `<name>: last backup 2d ago`, or `no backup yet` if none            | warn  |
| `failed`      | `<name>: last backup 5h ago` (the last success), or `no backup yet` | warn  |
| `disabled`    | `<name>: backups off`                                               | quiet |

Agents whose credential is revoked (`credentialActive = false`) are
decommissioned and are not shown (builder's call, recorded here).

- Time is the last **completed** run's `exportFinishedAt` (fallback
  `completedAt`), counted live. The tone comes from the server's `health`,
  never re-derived in the browser, so the card and the alerts agree.
- Hover on a line: exact local time of the last completed backup, the agent's
  health, and the latest error code if any.
- Lines are ordered by agent name. The single-agent form drops the name.
- **Version rule:** the version shown is the reported version of the agents on
  that server. One distinct value: `backup 0.3.0`. Several (an update half
  done): `backup 0.2.0/0.3.0`, lowest first. No agent has reported a version
  yet: the `backup …` segment is omitted.
- Pure presentation goes in `apps/dashboard/src/lib/` with tests, like
  `fleet-presentation.ts` and `backup-presentation.ts`.

## Data flow

**Version reporting.** A new agent-side call reports the running version per
agent instance. The server stores it on the agent row (`reported_version`,
`version_reported_at`, additive migration `0015_…`). Every backup run also
reports it, so a version is recorded even before the first update check. The
version is metadata on the run start, **not** part of the idempotent
"same parameters" comparison: a pending bundle written by 0.2.0 and retried by
0.3.0 must still be accepted.

**Update health (my call).** The check-in also carries the outcome of the
host's last update attempt (`ok`, or a bounded error code such as
`checksum_mismatch`, `downgrade_refused`, `lock_timeout`, `download_failed`).
The server stores it with the version. On the card, a failing update colours
the `backup …` version segment warn, and its hover names the code and the
release the server offers. A host that is merely on an older version but
updating normally is not flagged.

**Update feed.** New routes under `/api/backup/v1`, authorised by the
backup-agent credential like every other route there:

- a check-in that records the caller's version and answers with the release
  manifest (version, per-platform file name, size, sha256): the backup analogue
  of `GET /agent/version`;
- a binary download for a manifest file: the analogue of `GET /agent/{file}`.

The image already builds `/app/backup-agent/flatline-backup-linux-{amd64,arm64}`,
`VERSION-BACKUP` and `sha256sums-backup`, but the backend can only serve
`FLATLINE_AGENT_DIR` (`/app/agent`) with telemetry file names today. This work
adds a backup-agent directory setting (set in `docker/rust.dockerfile` and
`dev.sh`) and its own file allow-list. Documented
in `openapi.json` and `docs/api.md`.

**Board feed.** The Superboard loads all backup agents once
(`GET /api/v1/backup-agents`, paged, already exists) and groups them by
`monitorId`. `AgentSummary` gains `reportedVersion`. It refreshes on the
existing `{"type":"backups"}` live event; a version report publishes that
event too. One request for the whole board, never one per card.

## Self-update on the host

- `flatline-backup install` also writes a host-level
  `flatline-backup-update.service` + `.timer` (daily, randomized delay,
  `Persistent=true`), enabled by default, separate from the per-instance
  backup timers. Re-running `install` for another instance is idempotent for
  these units.
- A new `flatline-backup self-update` command (what the timer runs):
  1. discover instances from the installed `flatline-backup@<name>.service`
     units (their `ExecStart` names the config path), **not** by globbing
     `/etc/flatline-backup/*.json`, which also holds S3 credential files. For
     each, check in with that instance's token, reporting the running version
     (so every project's row stays current). All instances on a host must
     share one `serverUrl`; if they disagree, no update is applied and
     `server_mismatch` is reported;
  2. if the manifest offers a newer version for this platform, download it to
     a root-only staging directory, verify size and sha256 against the
     manifest, and confirm `<staged> version` prints the expected version;
  3. take every instance's run lock (the same lock `run-once` holds); if any
     backup is running, wait for it rather than swap under it (bounded wait,
     then give up until the next check with `lock_timeout`). The locks are
     held only for the swap itself (milliseconds), so a backup starting at
     that instant is not meaningfully delayed;
  4. keep the current binary as `flatline-backup.prev`, atomically rename the
     staged binary into place, release the locks;
  5. run the new binary's `install --refresh-units` step (my call), which
     re-renders every instance unit and the update units from their configs
     and runs `daemon-reload`, so a later version that changes a unit reaches
     hosts without a manual visit; this mirrors the telemetry agent's
     rewrite-its-own-unit fix (G1);
  6. check in again with the new binary so the server records the new version.
     On any failure the old binary stays and the reason is logged and reported.
- Opt-out per host, mirroring `self_update: false` on the telemetry agent (the
  builder picks the exact switch; it must be documented in
  `docs/backup-agent.md`).
- Downgrades are refused, as with the telemetry agent.

Unlike `superboard`, nothing long-running has to be restarted: each backup run
is a fresh process, so the next run simply starts the new binary.

## Versioning and rollout

- Backup agent version is `const version` in `backup-agent/main.go`. This
  work ships as **0.3.0**. Each future backup-agent change bumps it, recorded
  as a rule in `AGENTS.md` alongside the telemetry-agent rule.
- Server first: the new routes and migration ship in an office release. Older
  agents (0.2.0) never call them and keep working.
- meks: install 0.3.0 by hand once (download from the office image, verify
  sha256, `flatline-backup install` again for both instances so the update
  timer is written). From then on it updates itself.
- The telemetry agent's version and self-update are untouched. The pending
  1.8.1 bump is not part of this work.

## Constraints

- Docs change with behaviour: `docs/backup-agent.md` (update timer, opt-out,
  rollout), `docs/superboard.md` (card anatomy), `docs/api.md` and
  `openapi.json` (new routes, new field), `docs/deployment.md` (backup agent
  version on release).
- Checks per `AGENTS.md`: backend, dashboard, backup agent (`-race`), format.
- Never push or deploy without the operator's go-ahead.

## Left to the builder

- Exact route paths and payload shapes of the check-in and download.
- Exact migration name and column types.
- The opt-out switch's name and where it lives.
- Lock-wait bound and update-timer schedule/jitter values (daily, spread over
  roughly an hour, as the telemetry agent does).
- Styling details of the backup lines within the existing card tokens.
