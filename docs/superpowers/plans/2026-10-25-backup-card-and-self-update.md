# Backup Status on Cards and Backup-Agent Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Superboard cards show each server's backup-agent version and a live "last backup" line per backup agent (flagging the card when one is overdue or failed), and the backup agent keeps itself current from the Flatline server on its own version line.

**Architecture:** The backend records each backup agent's reported version and last update outcome (new columns, set by a new agent check-in route and by run starts) and serves the backup binaries through two new routes under `/api/backup/v1`. The Go backup agent gains a `checkin` client call, a host-level `self-update` command run by its own daily timer, and unit refresh. The dashboard groups all backup agents by monitor once per board load, and pure presentation helpers turn them into card lines, a version segment and an attention flag.

**Tech Stack:** Rust (axum, sqlx/SQLite), Go 1.27 (backup agent), React + TypeScript (Vite), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-25-backup-card-and-self-update-design.md`

## Global Constraints

- Backup-agent version line is independent: `const version` in `backup-agent/main.go` ships as **`0.3.0`**. The telemetry agent (`superboard/main.go`, `1.8.0` on master) is not touched; the pending 1.8.1 bump is not part of this work.
- Backup-agent tokens stay confined to `/api/backup/v1`. `/agent/version` and `/agent/{file}` keep refusing them.
- Migrations are additive: new file `backend-rs/migrations/0015_backup_agent_versions.sql`; never edit 0012–0014.
- Card copy, exact: `backup 0.3.0`; `backup 0.2.0/0.3.0` (distinct versions, lowest first); `<name>: last backup 3h ago`; `last backup 3h ago` (exactly one agent); `<name>: no backup yet`; `<name>: backups off`; headline `Backup overdue` (one flagged agent) / `<n> backups behind` (several).
- Age format `Xs/Xm/Xh/Xd ago`, ticking each second like `Updated`, using the existing `ageOf` from `FleetCard.tsx`.
- Tone comes from server `health` only: `overdue`, `failed` → warn; `healthy`, `pending`, `disabled` → quiet. Agents with `credentialActive = false` are not shown.
- Backup flags make card attention at least `warn`, never `bad`; headline priority: host down > websites down > stale data > metric issues > backups > high usage.
- Self-update: daily timer `flatline-backup-update.timer`, `RandomizedDelaySec=3600`, `Persistent=true`, enabled by `install`; runs while backup timers are disabled. Downgrades refused. Old binary kept as `/usr/local/bin/flatline-backup.prev`.
- Update status codes (bounded, `^[a-z_]{1,40}$`): `ok`, `download_failed`, `checksum_mismatch`, `version_mismatch`, `downgrade_refused`, `lock_timeout`, `server_mismatch`, `swap_failed`, `no_asset`.
- Never push, deploy or restart production without the operator's go-ahead in the conversation (Task 7 asks).
- Docs change with behaviour (`docs/backup-agent.md`, `docs/superboard.md`, `docs/api.md`, `openapi.json`, `docs/deployment.md`, `AGENTS.md`).

## Review Focus

1. A pending bundle written by 0.2.0 and retried by 0.3.0 (now sending `agentVersion`) must be accepted as the same run, not refused as changed parameters. Test in Task 1.
2. `self-update` while a `run-once` holds an instance lock must wait, then give up with `lock_timeout` and leave the old binary in place. Test in Task 4.
3. A staged binary whose `version` output differs from the manifest, or whose sha256 differs, must never replace the current binary. Test in Task 4.
4. Instances on one host pointing at different `serverUrl`s must not update (`server_mismatch`). Test in Task 4.
5. A board with more than 50 backup agents (the list endpoint pages at 50) must still show every agent's line. Test in Task 6.

---

### Task 1: Record reported versions and update status (backend)

**Files:**

- Create: `backend-rs/migrations/0015_backup_agent_versions.sql`
- Modify: `backend-rs/src/backups/mod.rs` (`AgentRow`, `AGENT_COLUMNS`, `AgentSummary`, `agent_summary_from_row`, `start_run` same-params check), `backend-rs/src/backups/runs.rs` (`StartRun`)
- Test: `backend-rs/tests/backup_versions.rs` (new)

**Interfaces:**

- Produces: `AgentSummary { reported_version: Option<String>, version_reported_at: Option<String>, update_status: Option<String>, .. }` serialized `reportedVersion`, `versionReportedAt`, `updateStatus`.
- Produces: `StartRun.agent_version: Option<String>` (`#[serde(default)]`, JSON `agentVersion`).
- Produces: `Backups::record_version(&self, agent_id: &str, version: &str, update_status: Option<&str>) -> Result<(), Error>`; validates `version` against `^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$` (≤32 chars) and `update_status` against `^[a-z_]{1,40}$`, else `Error::BadRequest`; sets `version_reported_at` to now (RFC3339 ms UTC); calls `publish_change()`. A `None` status leaves the stored status unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/backup_versions.rs` (harness helpers as in `tests/backup_uploads.rs`: `harness_with_backups`, `register`, `start_run_with_summary`):
  - `run_start_records_agent_version`: start a run with `"agentVersion": "0.3.0"`; `GET /api/v1/backup-agents` shows that agent with `reportedVersion == "0.3.0"` and a non-null `versionReportedAt`.
  - `retry_with_new_version_is_the_same_run`: start `clientRunId "r1"` without `agentVersion`, then again with identical fields plus `"agentVersion": "0.3.0"`; both answer 200 with the same `run.id`.
  - `malformed_agent_version_is_rejected`: `"agentVersion": "latest"` → 400.
  - `agents_without_reports_have_null_version`: a freshly registered agent lists `reportedVersion: null`, `updateStatus: null`.
- [ ] **Step 2: Run** `cargo test --manifest-path backend-rs/Cargo.toml --test backup_versions` — expect FAIL (unknown field / missing keys).
- [ ] **Step 3: Implement.** Migration adds `reported_version TEXT`, `version_reported_at TEXT`, `update_status TEXT` to `backup_agents`. Extend `AgentRow`/`AGENT_COLUMNS`/`AgentSummary`. `start_run` calls `record_version(agent, v, None)` when `agent_version` is present, after validation and **outside** the same-params comparison.
- [ ] **Step 4: Run** the new tests and `cargo test --manifest-path backend-rs/Cargo.toml --test backup_uploads --test backups` — expect PASS.
- [ ] **Step 5: Commit** `feat(backups): record backup-agent versions and update status`.

### Task 2: Check-in and release routes (backend)

**Files:**

- Modify: `backend-rs/src/config.rs` (new `backup_agent_dir: PathBuf`, env `FLATLINE_BACKUP_AGENT_DIR`, default `/app/backup-agent`), `backend-rs/src/api/backups.rs` (routes + handlers), `backend-rs/src/api/provisioning.rs` (generalize `agent_assets` / file streaming over a directory + prefix, reused, not duplicated), `docker/rust.dockerfile` (`ENV FLATLINE_BACKUP_AGENT_DIR=/app/backup-agent` next to `FLATLINE_AGENT_DIR`), `backend-rs/src/api/openapi.json`, `docs/api.md`
- Test: `backend-rs/tests/backup_versions.rs`

**Interfaces:**

- Consumes: `Backups::record_version` (Task 1).
- Produces: `POST /api/backup/v1/checkin` (agent routes group, `require_agent`). Body `{"version": "0.2.0", "platform": "linux-amd64", "updateStatus": "ok" | null}`. Response `{"ok": true, "release": {"version": "0.3.0" | null, "assets": [{"platform": "linux-amd64", "file": "flatline-backup-linux-amd64", "size": 10800000, "sha256": "<64 hex>"}]}}`. `release.version` is the trimmed contents of `<backup_agent_dir>/VERSION-BACKUP`, `null` when absent.
- Produces: `GET /api/backup/v1/release/{file}` in `transfer_routes` with `require_agent`; streams `<backup_agent_dir>/<file>` for names matching prefix `flatline-backup-` plus `[A-Za-z0-9_-]+`; anything else or missing → 404. `Content-Type: application/octet-stream`, `Cache-Control: no-store`.

- [ ] **Step 1: Write the failing tests** (point the harness's `backup_agent_dir` at a temp dir containing `VERSION-BACKUP` = `0.3.0\n` and a file `flatline-backup-linux-amd64` with known bytes):
  - `checkin_records_version_and_returns_release`: check-in with `{"version":"0.2.0","platform":"linux-amd64","updateStatus":"ok"}` → `release.version == "0.3.0"`, the asset's `sha256` equals the file's digest; the agent then lists `reportedVersion "0.2.0"`, `updateStatus "ok"`.
  - `release_download_streams_exact_bytes`: GET the asset with the agent token → 200 and identical bytes.
  - `release_routes_refuse_other_credentials`: the operator token and a push token on both routes → the same 401 shapes `require_agent` already returns.
  - `release_rejects_foreign_file_names`: `superboard-linux-amd64`, `..%2Fflatline.db`, `VERSION-BACKUP` → 404.
  - `missing_release_dir_reports_null_version`: no directory → `release.version == null`, `assets == []`.
  - `agent_feed_still_refuses_backup_tokens`: `GET /agent/version?token=<backup token>` → still 401/403 as today.
- [ ] **Step 2: Run** `cargo test --manifest-path backend-rs/Cargo.toml --test backup_versions` — expect FAIL (404 routes).
- [ ] **Step 3: Implement** the config field, the shared asset helper (prefix and directory as parameters, existing digest cache reused), the two handlers, the Dockerfile `ENV`, and the `openapi.json` and `docs/api.md` entries.
- [ ] **Step 4: Run** `cargo test --manifest-path backend-rs/Cargo.toml` (whole suite: `provisioning.rs` and `completeness.rs` cover the refactored helper and the OpenAPI document) and `cargo clippy --manifest-path backend-rs/Cargo.toml --all-targets` — expect PASS, no warnings.
- [ ] **Step 5: Commit** `feat(backups): check-in and release routes for backup-agent self-update`.

### Task 3: Agent reports its version (backup agent)

**Files:**

- Modify: `backup-agent/upload.go` (`start` body gains `"agentVersion": version`; new `func (c *UploadClient) checkin(ctx context.Context, platform, updateStatus string) (Release, error)`), `backup-agent/main.go` (`version = "0.3.0"`)
- Create: `backup-agent/release.go` (types `Release{Version string; Assets []ReleaseAsset}`, `ReleaseAsset{Platform, File string; Size int64; SHA256 string}`, `func platformID() string` returning `runtime.GOOS + "-" + runtime.GOARCH`)
- Test: `backup-agent/upload_test.go`

**Interfaces:**

- Consumes: Task 2's check-in shape.
- Produces: `checkin`, `Release`, `ReleaseAsset`, `platformID()`; `updateStatus == ""` is sent as JSON `null`.

- [ ] **Step 1: Write the failing tests** against the existing fake server in `upload_test.go`: `TestStartSendsAgentVersion` (start body has `agentVersion == version`); `TestCheckinParsesRelease` (fake answers the Task 2 shape → `Release{Version: "0.3.0", Assets: [...]}`); `TestCheckinSendsNullStatusWhenEmpty`.
- [ ] **Step 2: Run** `cd backup-agent && go test -run 'AgentVersion|Checkin' .` — expect FAIL.
- [ ] **Step 3: Implement** using `c.request` (bounded body, existing retry/backoff); bump `version` to `0.3.0`.
- [ ] **Step 4: Run** `cd backup-agent && go vet ./... && go test -race ./...` — expect PASS.
- [ ] **Step 5: Commit** `feat(backup): report the agent version on start and check-in`.

### Task 4: `self-update` command, update timer and unit refresh (backup agent)

**Files:**

- Create: `backup-agent/selfupdate.go`, `backup-agent/selfupdate_test.go`
- Modify: `backup-agent/install.go` (render and write `flatline-backup-update.service` + `.timer`, enable the timer on every `install`; new `func RefreshUnits(options installOptions) error`), `backup-agent/main.go` (commands `self-update` and `install --refresh-units`), `backup-agent/config.go` (lock acquisition with a bounded wait), `docs/backup-agent.md`

**Interfaces:**

- Consumes: `checkin`, `Release`, `platformID()` (Task 3); `LoadConfig`, `AcquireInstanceLock`, `installOptions`, `renderService`, `renderTimer` (existing).
- Produces: `func discoverInstances(unitDir string) ([]string, error)` → config paths parsed from `ExecStart=… run-once --config <path>` in `flatline-backup@*.service` (systemd-escaped values handled; sorted).
- Produces: `func SelfUpdate(ctx context.Context, options updateOptions) (status string, err error)`; `updateOptions` injects `unitDir`, `binaryPath` (default `/usr/local/bin/flatline-backup`), `stagingDir` (default `/var/lib/flatline-backup/update`, 0700), `lockWait` (default 30 minutes), an HTTP client, and a `probeVersion(path) (string, error)` hook (default runs `<path> version`).
- Produces: `func acquireInstanceLockWait(stateDir string, wait time.Duration) (io.Closer, error)` — retries the existing non-blocking flock every second until `wait` elapses.
- Opt-out (builder's call recorded in the spec): the file `/etc/flatline-backup/self-update.disabled` makes `self-update` check in (version reporting continues) but never download or swap; status reported `ok`.

Algorithm (the order matters; the rest is the implementer's):

1. Discover instances; none → exit 0. Load every config; any differing `serverUrl` → status `server_mismatch`, checks in for each, no update.
2. Check in for each instance with the **previous** run's status (persisted in `<stagingDir>/last-status`), collecting the first instance's `Release`.
3. No newer version (compare as in `superboard/selfupdate.go` `compareVersions`, suffixes ignored) → `ok`. Older → `downgrade_refused`. No asset for `platformID()` → `no_asset`.
4. Download to `<stagingDir>/flatline-backup.new` via `GET /api/backup/v1/release/<file>`; size or sha256 mismatch → `checksum_mismatch`; `probeVersion` ≠ manifest version → `version_mismatch`. Failed download → `download_failed`.
5. Acquire every instance's lock with `acquireInstanceLockWait(stateDir, lockWait)`; any timeout → release all, `lock_timeout`.
6. Copy current binary to `<binaryPath>.prev`, rename staged binary over `binaryPath` (same filesystem: stage under `/usr/local/bin/.flatline-backup.new` for the final rename); failure → `swap_failed`, `.prev` restored. Release locks.
7. Exec `<binaryPath> install --refresh-units` (re-renders every discovered instance unit and the update units, `daemon-reload`), then check in again with status `ok` using the new binary.
8. Persist the status to `<stagingDir>/last-status`; exit 0 for `ok`, 1 otherwise.

- [ ] **Step 1: Write the failing tests** in `selfupdate_test.go` with a fake HTTP server (check-in + release routes), temp `unitDir`/`binaryPath`/`stagingDir`, and a fake `probeVersion`:
  - `TestDiscoverInstancesFromUnits` (two units, one with a quoted path → both config paths; a stray `meks-s3.json` beside them is not returned).
  - `TestSelfUpdateSwapsVerifiedBinary` (manifest 0.3.0, running 0.2.0 → binary content replaced, `.prev` holds the old bytes, second check-in carries `ok`).
  - `TestSelfUpdateRejectsChecksumMismatch` and `TestSelfUpdateRejectsWrongVersion` (binary unchanged, status `checksum_mismatch` / `version_mismatch`).
  - `TestSelfUpdateWaitsForRunningBackup` (hold one instance lock, `lockWait` 2s → `lock_timeout`, binary unchanged).
  - `TestSelfUpdateRefusesMixedServers` (`server_mismatch`, no download requested).
  - `TestSelfUpdateRefusesDowngrade`, `TestSelfUpdateDisabledStillChecksIn`.
  - In `install_test.go`: `TestInstallWritesUpdateTimer` (update service runs `flatline-backup self-update`; timer has `RandomizedDelaySec=3600`, `Persistent=true`, is enabled) and `TestRefreshUnitsRewritesInstances`.
- [ ] **Step 2: Run** `cd backup-agent && go test -run 'SelfUpdate|Discover|UpdateTimer|RefreshUnits' .` — expect FAIL.
- [ ] **Step 3: Implement** per the algorithm and interfaces.
- [ ] **Step 4: Run** `cd backup-agent && gofmt -l . && go vet ./... && go test -race ./...` — expect PASS, no files listed.
- [ ] **Step 5: Document** in `docs/backup-agent.md`: the update timer, the opt-out file, the status codes, `.prev` rollback (`mv flatline-backup.prev flatline-backup`), and that `install` writes the update units. `npm run fmt:check` passes for it.
- [ ] **Step 6: Commit** `feat(backup): self-update on its own daily timer`.

### Task 5: Card presentation helpers (dashboard)

**Files:**

- Create: `apps/dashboard/src/lib/backup-card.ts`, `apps/dashboard/test/backup-card.test.mjs`
- Modify: `apps/dashboard/src/lib/api.ts` (`BackupAgentSummary` gains `reportedVersion: string | null; versionReportedAt: string | null; updateStatus: string | null`)

**Interfaces:**

- Consumes: `BackupAgentSummary` (with Task 1 fields); `ageOf(value, now)` (move it from `FleetCard.tsx` into `src/lib/` if needed so both import it; keep its behaviour).
- Produces:
  - `type BackupLine = { key: string; text: string; tone: "quiet" | "warn"; title: string }`
  - `backupLines(agents: BackupAgentSummary[], now: number): BackupLine[]` — filters `credentialActive`, sorts by name, applies the Global Constraints copy; single agent drops the `<name>: ` prefix; time from `lastCompletedRun.exportFinishedAt ?? lastCompletedRun.completedAt`; `title` = local exact time · health · `lastErrorCode` if any.
  - `backupVersion(agents: BackupAgentSummary[]): { text: string; tone: "quiet" | "warn"; title: string } | null` — distinct `reportedVersion`s compared numerically, lowest first, joined by `/`; `null` when none reported; warn when any `updateStatus` is set and not `ok`, title names the code.
  - `backupAttention(agents: BackupAgentSummary[]): { flagged: number; headline: string | null }` — counts shown agents with health `overdue`/`failed`; headline `Backup overdue` (1) or `${n} backups behind` (n > 1), else `null`.

- [ ] **Step 1: Write the failing tests** in `backup-card.test.mjs` covering: one healthy agent → `last backup 3h ago`; two agents sorted with names; each health row of the spec table including `overdue` with no completed run → `no backup yet` warn and `pending` → quiet; revoked agent hidden; versions `["0.3.0","0.2.0","0.3.0"]` → `backup 0.2.0/0.3.0`; `"0.10.0"` sorts after `"0.9.0"`; failing `updateStatus` → warn; `backupAttention` counts and headlines (`Backup overdue`, `2 backups behind`, `null`); `pending`/`disabled` never flag.
- [ ] **Step 2: Run** `npm run test:dashboard` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `backup-card.ts`.
- [ ] **Step 4: Run** `npm run test:dashboard && npm run typecheck:dashboard` — expect PASS.
- [ ] **Step 5: Commit** `feat(board): backup line, version and attention helpers`.

### Task 6: Wire backups into the Superboard (dashboard)

**Files:**

- Modify: `apps/dashboard/src/lib/api.ts` (new `fetchAllBackupAgents(signal?: AbortSignal): Promise<BackupAgentSummary[]>` following `nextCursor` until null), `apps/dashboard/src/components/Superboard.tsx` (load once per board load, group by `monitorId` onto each `FleetServer`, reload on the live hub's `backups` callback, include flagged backups in `attentionCount`), `apps/dashboard/src/components/FleetCard.tsx` (`FleetServer.backups?: BackupAgentSummary[]`; version segment after `agent …` in the subline; one ticking line per `BackupLine` under the `Updated` line in `.fleet-health`, warn class for warn tone, `title` hover; attention and headline per Global Constraints), `apps/dashboard/src/index.css` (only if the existing `.fleet-freshness` style doesn't fit the extra lines), `docs/superboard.md` (card anatomy and the new attention rule)
- Test: `apps/dashboard/test/backups.test.mjs`

**Interfaces:**

- Consumes: Task 5 helpers; `fetchBackupAgents` (existing); live hub `backups` subscriber.
- Produces: `fetchAllBackupAgents`.

- [ ] **Step 1: Write the failing tests** in `backups.test.mjs`, in the style of the existing "API reads send Authorization" test: `fetchAllBackupAgents` follows `nextCursor` across three pages (60 agents total → 60 returned, three requests, cursor passed back each time); it stops when `nextCursor` is `null`.
- [ ] **Step 2: Run** `npm run test:dashboard` — expect FAIL.
- [ ] **Step 3: Implement** `fetchAllBackupAgents`, then the Superboard and FleetCard wiring. The backup lines tick with the same 1 s, hidden-tab-aware interval as `SampleAge`. A backup-fetch failure must not break the board: keep the last known agents and log once.
- [ ] **Step 4: Run** `npm run test:dashboard && npm run typecheck:dashboard && npm run build:dashboard`, then `npx prettier --check` on every file this work touched — expect PASS. (`npm run fmt:check` on the whole tree already flags files from earlier work; leave those alone.)
- [ ] **Step 5: Look at it**: `./dev.sh`, register a backup agent against a mock-fleet monitor via the API, open `/superboard`, and confirm the subline, the per-agent lines ticking, and the card flag for an overdue agent (shift its `created_at` back 37 h in the dev DB). Screenshot for the operator.
- [ ] **Step 6: Commit** `feat(board): backup version and last-backup lines on Superboard cards`.

### Task 7: Records and rollout

**Files:**

- Modify: `AGENTS.md` (rule: backup-agent changes bump `const version` in `backup-agent/main.go`, separate from the telemetry agent), `docs/deployment.md` (release log row; backup agent 0.3.0 and its self-update), `docs/superpowers/specs/2026-10-25-backup-card-and-self-update-design.md` (status: implemented)

- [ ] **Step 1: Update the records** above; `npm run fmt:check` clean for them. Commit `docs: record backup-agent self-update and the card change`.
- [ ] **Step 2: Ask the operator for the go-ahead** to deploy the office server (routes + migration 0015). Without it, stop here.
- [ ] **Step 3: Deploy office** per `docs/deployment.md` "Releasing" (scratch tag, `office-prev-<REL>`, SQLite online backup with `integrity_check ok`, both compose files). Build from a tree that keeps `superboard/main.go` at `1.8.0` unless the operator has approved 1.8.1. Verify: healthy, `/healthz` 200, `_sqlx_migrations` includes 0015, `GET /api/v1/backup-agents` shows `reportedVersion` keys.
- [ ] **Step 4: Manual hop on meks** (approved by the operator): copy `/app/backup-agent/flatline-backup-linux-amd64` out of the new image, verify it against `sha256sums-backup`, install to `/usr/local/bin/flatline-backup`, run `flatline-backup install --config /etc/flatline-backup/modernization.json` and the same for `zhkh` (backup timers stay disabled; the update timer is enabled), then `flatline-backup self-update`. Expected: exit 0, both agents list `reportedVersion "0.3.0"`, `updateStatus "ok"`; `systemctl list-timers flatline-backup-update.timer` shows a next run.
- [ ] **Step 5: Check the board**: the meks card shows `agent 1.8.0 · backup 0.3.0` and `modernization: last backup …` / `zhkh: last backup …` lines.
