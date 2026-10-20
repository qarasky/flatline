# Named Backup Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Recommend native execution here; the user must review this plan and choose before implementation.

**Goal:** Back up MEKS Docker PostgreSQL and Garage daily to the office mirror, with independent named agents, visible health, and proven restoration.

**Architecture:** A new Go binary exports and encrypts a complete application bundle, then delivers it through resumable HTTPS uploads. The existing Rust backend owns agent credentials, upload storage, retention and backup health; its existing dashboard displays linked backup agents. The telemetry agent remains independent.

**Tech Stack:** Go 1.27, `filippo.io/age`, AWS SDK for Go v2 S3, Linux systemd and Docker; Rust/Axum/SQLx SQLite; React/TypeScript. Resolve and lock compatible dependency versions when implementing; no CLI download or shell script is needed to perform encryption or S3 operations.

**Spec:** `docs/superpowers/specs/2026-10-19-backup-agent-design.md` (approved; base commit `86dfe607`).

## Global Constraints

- Work only in `feature/backup-agent`; do not alter the user's main checkout or concurrent work.
- Pilot: `meks`, `modernization-postgres-1`, database `modernization`, `modernization-garage-1`, bucket `meks-media`. Do not change the `zhkh` stack.
- One binary: `/usr/local/bin/flatline-backup`; instance units: `flatline-backup@<name>.service`.
- Configurations: `/etc/flatline-backup/<name>.json`, mode 0600; state: `/var/lib/flatline-backup/<name>/`, mode 0700.
- Names: lowercase ASCII letters, digits, hyphens and underscores, 1–64 characters, beginning with a letter or digit.
- Default schedule: 02:00 Asia/Almaty daily, with up to ten minutes of jitter.
- At most one pending encrypted bundle per instance; local spool and encrypted bundle caps: 8 GiB each.
- Resumable upload chunks: at most 8 MiB; office free-space reserve: at least 100 GiB.
- Office storage: `/mnt/mirror/flatline-backups`, configured through `FLATLINE_BACKUP_DIR`; no root-filesystem fallback.
- Seven completed recovery points per agent; abandoned uploads expire after 48 hours.
- Overdue threshold: 36 hours since the latest completed export or initial registration; disabled agents do not alert.
- Source secrets and age private keys never enter logs, CLI arguments, reports or Git. The source has only the recovery public key.
- Exact current S3 object keys and contents must round-trip. No bucket policy or historical-version recovery.
- Transfer verification, archive verification and actual restore verification are different states.
- Keep daily timers disabled until an isolated MEKS restore succeeds. No implementation or deployment before plan approval.

## Review Focus

1. An old locally queued export uploads today: health must use its export time, not receipt time (Tasks 1, 3, 6).
2. A crash occurs between filesystem and SQLite commits: retry/restart must reconcile one durable upload without reporting a false success (Tasks 2, 3).
3. Two agents race for the last available space: reservations and actual bytes must not be double-counted or overcommitted (Task 2).
4. Archive/key names resemble paths, database flags or file prefixes: restore and subprocess execution must not normalize keys or select unintended targets (Tasks 4, 5, 7).
5. A restore fails midway or an old React request resolves after switching monitors: neither may be presented as a verified current backup (Tasks 7, 8).

## Shared contracts and file boundaries

Use one new Go module `flatline-backup` in `backup-agent/`, package `main`, split by responsibility: `config.go`, `manifest.go`, `archive.go`, `spool.go`, `postgres.go`, `s3.go`, `upload.go`, `run.go`, `restore.go`, `install.go`, `main.go`; put tests beside their owners. Reuse neither telemetry buffering nor its push credential.

Rust backup logic lives under `backend-rs/src/backups/`: `mod.rs` (types/service), `agents.rs` (registration/auth), `storage.rs` (durable upload I/O), `runs.rs` (state transitions), `maintenance.rs` (reconciliation/retention) and `alerts.rs` (health). HTTP handlers live in `backend-rs/src/api/backups.rs`. Integrate through `AppState.backups: Arc<backups::Backups>`; workers start only in `run()`, not in test construction.

### HTTP contract

All metadata JSON uses camelCase, UUID strings, RFC3339 UTC timestamps and integer bytes. Errors use existing `{ok:false,error,message}` envelopes. Operator routes use existing operator middleware. Agent routes use dedicated backup credentials in `Authorization: Bearer ...`, independently of operator and telemetry credentials. No token in a URL. Authenticated access to another agent's run returns 404.

- `GET /api/v1/backup-agents?monitorId=<id>&limit=50&cursor=<id>` lists agent summaries; omitted monitor includes unlinked agents. Limit 1–200.
- `POST /api/v1/backup-agents` accepts `{name,monitorId:null|integer,enabled:true,intervalSeconds:86400,retentionCount:7}`; returns 201 `{ok,agent,token}` with plaintext once. Enforce unique `(monitorId,name)` for linked agents; UUID remains the identity.
- `PATCH /api/v1/backup-agents/{id}` accepts those settings; `POST .../{id}/rotate-token` returns a replacement token once, invalidating the previous credential. `POST .../{id}/revoke-token` revokes without deleting history; reads expose `credentialActive`, never a hash.
- `GET /api/v1/backup-agents/{id}/runs?limit=20&cursor=<id>` returns newest-first paginated runs.
- `GET /api/v1/backup-runs/{id}/download` streams only completed retained bundles with `application/octet-stream`, a generated attachment filename and `Cache-Control: no-store`. Fetch with operator Authorization; never a tokenized download link.
- `POST /api/v1/backup-runs/{id}/verification` accepts `{kind:"archive"|"restore",status:"passed"|"failed",checkedAt,summary}` from operators only; summary is bounded to 2 KiB. No agent can self-assert a restore test.
- `POST /api/backup/v1/runs` accepts `{clientRunId,exportStartedAt,exportFinishedAt,totalBytes,sha256,sourceSummary}` and returns `{ok,run}` including server run UUID, status and committed offset. `(agentId,clientRunId)` is unique; equal retries return the existing run, conflicting parameters return 409. An expired run with identical parameters can be reopened at offset zero after its old bytes are removed and capacity is reserved again; this permits recovery after a prolonged outage without changing the bundle identity. Allow one uploading/finalizing run per agent. Require `0 < totalBytes <= 8589934592`, lowercase 64-character SHA-256, ordered times no more than five minutes in the future, and bounded summary `{databaseCount,objectCount,sourceBytes}`. Treat summary as agent-reported, not independently verified.
- `GET /api/backup/v1/runs/{id}` returns own status/offset. `PUT .../{id}/chunks/{index}` requires binary body, `X-Backup-Offset` and `X-Backup-Sha256`. Chunk index is `offset / 8388608`; full-size chunks except the final chunk. Successful replies include the next committed offset. Byte-identical retries return that offset; conflicts return 409, hash mismatches 422, oversized chunks 413, unavailable/full storage 503/507. Authenticate before reading body; do not raise the telemetry endpoint's 256 KiB limit.
- `POST /api/backup/v1/runs/{id}/complete` finalizes idempotently. Failed full hash is 422 and cannot become completed.
- `POST /api/backup/v1/failures` accepts `{clientRunId,exportStartedAt,code}` even when export failed before upload. `code` is a bounded enum, not raw stderr; same clientRunId is idempotent. It can fail an uploading run but cannot overwrite a completed run.

Run states: `uploading`, `finalizing`, `completed`, `failed`, `expired`, `deleting`, `pruned`. Summaries retain the latest run, latest completed export, separate latest archive/restore results, persisted alert state and `health: "disabled"|"pending"|"healthy"|"failed"|"overdue"`. Store run metadata after pruning; prune bytes, not the evidence of past runs. `intervalSeconds` is positive metadata (86400 by default); this pilot uses a fixed 36-hour overdue threshold as required by the spec. Schedule changes must not silently change that threshold.

Summary fields are fixed across Rust, Go and TypeScript: `AgentSummary = {id,name,monitorId,enabled,credentialActive,intervalSeconds,retentionCount,createdAt,health,lastErrorCode,latestRun,lastCompletedRun,latestArchiveVerification,latestRestoreVerification}`; `RunSummary = {id,agentId,clientRunId,status,exportStartedAt,exportFinishedAt,createdAt,completedAt,totalBytes,receivedBytes,sha256,sourceSummary,errorCode,archiveVerification,restoreVerification}`. Optional times, errors and missing runs are null. A verification is `{runId,status,checkedAt,summary}` or null. Agent-level latest verification fields point to the actual tested run, even if newer untested backups exist. Failures before export completion may have null exportFinishedAt/totalBytes/sha256. List envelopes are `{ok:true,agents|runs:[...],nextCursor:string|null}`; a run response is `{ok:true,run:RunSummary}`. UI duration is derived from export times; do not expose private paths or credential hashes. Per-agent latest verification is derived from its run records and never applied to a different run.

### Bundle and local contracts

Archive format version 1: encrypted binary age stream containing a tar archive with regular files only. Entries are generated identifiers `databases/000001.dump`, optional `globals/000001.sql`, `objects/000001`, then `manifest.json` last. Manifest: `{formatVersion:1,clientRunId,agentName,exportStartedAt,exportFinishedAt,postgres:[{container,database,serverVersion,clientVersion,extensions,tableCounts}],entries:[{path,kind,size,sha256,bucket?,key?,contentType?,database?}]}`. Entry kinds: `postgres`, `globals`, `object`. Times/counts never substitute for content hashes. Require strict unique paths and unique `(bucket,key)` object mappings; cap manifest at 32 MiB and 100,000 entries for this pilot, failing explicitly beyond either limit.

Local config version 1 fields: `name`, `serverUrl`, `tokenFile`, `recipient`, `stateDir`, `spoolMaxBytes` (default 8589934592), `uploadBytesPerSecond` (default 0/unlimited), `schedule` (default `*-*-* 02:00:00 Asia/Almaty`), `postgres:[{container,user,databases,includeGlobals}]`, `s3:[{endpoint,region,bucket,credentialsFile}]`. Credentials file: `{accessKeyId,secretAccessKey}`. HTTPS is mandatory for Flatline. For locally exposed Garage permit HTTP only on literal loopback addresses; reject other cleartext endpoints. Reject duplicate database names across PostgreSQL sources and duplicate bucket names across S3 sources within one instance, so restore mappings are unambiguous. Reject configuration whose effective state directory is not specific to its name. Do not rewrite source `.env` files or copy whole environments into agent config.

## Task 1: Register independent agents and define persisted runs

**Files:** Create `backend-rs/migrations/0012_backup_agents.sql`, `backend-rs/src/backups/{mod,agents,runs}.rs`, `backend-rs/src/api/backups.rs`, `backend-rs/tests/backups.rs`; modify `backend-rs/{Cargo.toml,Cargo.lock}`, `backend-rs/src/{lib,config}.rs`, `backend-rs/src/api/{mod.rs,openapi.json}`, `backend-rs/tests/common/mod.rs`.

**Interfaces:** Produce `Backups::new(pool: SqlitePool, config: Arc<Config>, events: Arc<Events>) -> Arc<Backups>`; `agents::authenticate(pool: &SqlitePool, token: &str) -> Result<Option<String>, sqlx::Error>` returns an agent UUID; typed `AgentSummary`, `RunSummary`, `StartRun`, `Verification`, `FailureReport`. Config gains `backup_dir: Option<PathBuf>`; absent storage leaves existing Flatline behavior operational. Use the UUID crate for generated IDs and existing `auth::hash_token` for dedicated random credentials.

- [ ] **Write tests first** in `backups.rs`: `multiple_agents_share_monitor_but_not_credentials` registers `meks` and `zhkhteam`, checks different UUIDs, no credential in list output, agent token → operator API 401, MEKS token → ZHKH run 404 (seed a run directly in SQLite for this ownership test; receiver implementation follows in Task 2), push/operator tokens → agent API 401. `monitor_deletion_preserves_agents` checks `ON DELETE SET NULL`; `rotation_and_revocation_preserve_history` checks old token 401. `run_metadata_validates_time_and_limits` rejects future/reversed export times, >8 GiB, invalid digests and conflicting clientRunId reuse.
- [ ] **Run RED:** `cargo test --manifest-path backend-rs/Cargo.toml --test backups`. Expected: new contract tests fail against missing routes/types, while the old suite remains unaffected.
- [ ] **Implement** registration/list/update/rotation/revocation, agent middleware and run/verification models. Persist agents, run metadata, chunk ledger `(run_id,index,offset,size,sha256)` and per-agent alert state; use explicit status/check constraints and indices. Keep worker APIs inert until subsequent tasks implement them. Add additive migration and update all Config/AppState constructors; migration number must be checked against this branch immediately before creation.
- [ ] **Run GREEN:** `cargo test --manifest-path backend-rs/Cargo.toml --test backups` (all identity/metadata tests pass). Document implemented routes in OpenAPI and check existing `completeness` tests.
- [ ] **Commit:** `feat: register independently authenticated backup agents`.

## Task 2: Receive bounded, resumable, durable bundles

**Files:** Create `backend-rs/src/backups/storage.rs`, `backend-rs/tests/backup_uploads.rs`; modify `backups/{mod,runs}.rs`, `api/{backups.rs,mod.rs,openapi.json}`, test harness, Cargo dependencies. Add `tokio-util` I/O support for streamed downloads, Tokio I/O features and a maintained filesystem-stat dependency.

**Interfaces:** `Storage::open(root: &Path) -> Result<Storage>` validates an existing root marker `.flatline-backup-storage` containing a provisioned UUID; never creates a missing root. `Backups::start_run(agent_id: &str, input: StartRun) -> Result<RunSummary>`; `put_chunk(agent_id: &str, run_id: &str, index: u64, offset: u64, sha256: &str, body: Body) -> Result<RunSummary>`; `complete_run(agent_id: &str, run_id: &str) -> Result<RunSummary>`. HTTP errors map to the shared contract. Inject available-space readings and fault points in tests, not production environment variables.

- [ ] **Write tests first:** `chunks_retry_resume_and_isolate` asserts 8 MiB and short final-chunk boundaries, identical retry, 409 conflicts and cross-agent denial; `hash_and_size_failures_never_complete` checks chunk/full hashes and declared total; `restart_recovers_committed_offset` injects crashes after append/fsync/DB update/rename and checks offset and final status. `concurrent_reservations_keep_100_gib_free` uses a fake free-space provider and two agents: with reserve + one bundle capacity only one start succeeds. `missing_storage_never_falls_back` removes marker/root and asserts 503 and no files in application data. Assert bounded stream reads and abort/cleanup on a body larger than 8 MiB even without Content-Length.
- [ ] **Run RED:** `cargo test --manifest-path backend-rs/Cargo.toml --test backup_uploads`. Expected: missing receiver behavior fails.
- [ ] **Implement** per-run serialized append and committed chunk ledger. Read chunks into a bounded buffer, verify before append, fsync before advancing SQLite offset, and truncate uncommitted tails on restart. Global reservation lock reserves `totalBytes` before accepting a run. Admission uses `freeBytes - sum(totalBytes - committedBytes for active runs) - newTotal >= 107374182400`; recheck physical space while writing. Do not hold a global lock across a whole network upload. Limit simultaneous upload-body readers to four; downloads stream through `ReaderStream`, never `read_to_end`.
- [ ] **Implement** finalization: persist `finalizing`, stream-check full digest/size, fsync file, atomically rename within the same directory, fsync directory, commit `completed`; retry/boot reconciliation finishes a valid published file or fails a corrupt run. All paths derive from UUIDs; reject symlinked storage entries. Recheck marker before mutations. Storage failures fail the backup API without taking down monitoring.
- [ ] **Run GREEN:** `cargo test --manifest-path backend-rs/Cargo.toml --test backup_uploads` (all fault/stream/capacity cases pass).
- [ ] **Commit:** `feat: receive resumable backups on dedicated storage`.

## Task 3: Retention, recovery after restart and backup alerts

**Files:** Create `backups/{maintenance,alerts}.rs`, `backend-rs/tests/backup_health.rs`; modify `backups/{mod,runs}.rs`, `backend-rs/src/lib.rs`, `api/backups.rs`, OpenAPI. Reuse `notify::linked` and `notify::dispatch_message`; no new notification channel.

**Interfaces:** `Backups::reconcile(now_ms: i64) -> Result<()>`, `Backups::maintain(now_ms: i64) -> Result<()>`, `Backups::evaluate_health(now_ms: i64) -> Result<()>`, `Backups::start_jobs(self: &Arc<Self>)`. Persist health transition before dispatch so restart does not repeat the same transition; delivery uses existing bounded Telegram retries and retains their delivery limitations.

- [ ] **Write tests first:** `seven_successes_survive_failed_eighth` asserts only completed retained bundles count, with last good backup never evicted to admit a run; `pruning_and_expiration_resume_after_restart` injects interruption between `deleting`, unlink and `pruned`, then checks idempotence, 48-hour abandoned cleanup and reservation release. `overdue_without_reports_is_detected` advances injected time to 36 hours after registration/latest export. `old_upload_does_not_clear_overdue` uploads a two-day-old bundle today and stays overdue. `alert_transitions_survive_restart` uses a local fake Telegram endpoint, checks one failure/overdue notification per transition, disabled suppression and recovery only after a fresh completion. `verification_is_operator_only` distinguishes transfer, archive and restore outcomes.
- [ ] **Run RED:** `cargo test --manifest-path backend-rs/Cargo.toml --test backup_health`. Expected: retention/health transitions fail.
- [ ] **Implement** boot reconciliation before accepting uploads, then maintenance/health ticks every 60 seconds in production. New completion schedules retention; use `deleting` → unlink/fsync → `pruned` for restart safety. Expire uploads with no accepted chunk/activity for 48 hours; cleanup only this storage tree's registered files. Health uses exportFinishedAt, not upload receipt; latest failed attempt remains visible even with older successful backups. Publish `events.invalidate()` on agent/run/verification/health changes, coalescing chunk-progress invalidations to at most once per second.
- [ ] **Run GREEN:** `cargo test --manifest-path backend-rs/Cargo.toml --test backup_health` (all tests pass, including no direct agent reports in overdue test).
- [ ] **Commit:** `feat: retain recovery points and alert on backup failures`.

## Task 4: Local configuration, bounded spool and encrypted archive format

**Files:** Create `backup-agent/{go.mod,go.sum,main.go,config.go,manifest.go,archive.go,spool.go}` and corresponding `_test.go` files; modify `.gitignore`/`.prettierignore` for the new binary/local artifacts. Fixtures use generated test keys and small bodies; never real client credentials.

**Interfaces:** `LoadConfig(path string) (Config, error)`; `AcquireInstanceLock(stateDir string) (io.Closer, error)`; `NewSpool(root string, maxBytes int64) (*Spool, error)`; `(*Spool).Create(name string) (io.WriteCloser, error)`; `WriteBundle(ctx context.Context, cfg Config, spool *Spool, export Export) (Bundle, error)`; `VerifyBundle(ctx context.Context, bundlePath, identityFile string) (VerifiedBundle, error)`. `Export` holds manifest and generated body paths; `Bundle` holds ciphertext path, byte size, SHA-256 and manifest summary. `VerifiedBundle` holds the validated manifest only; restore rereads the bundle. Defaults and manifest schema are specified above.

- [ ] **Write tests first:** `TestNamedConfigIsolation` rejects invalid names, insecure file modes, remote HTTP and accidental shared state dirs; distinct named configs use separate locks. `TestSpoolCountsIntermediateAndBundleBytes` uses a tiny configurable test cap to fail exactly before overrun including simultaneously retained files. `TestArchiveExactKeys` round-trips `a`, `a/b`, `/lead`, `x//y`, `../x`, `trail/`, Unicode and zero bytes through a generated age identity. `TestVerifyRejectsMalformedArchives` covers tampering, truncation, duplicate/unexpected entries, unsupported format version, forged length, oversized manifest, missing entries and duplicate bucket/key mappings.
- [ ] **Run RED:** `go -C backup-agent test ./...`. Expected: the new tests fail against absent functions.
- [ ] **Implement** strict config parsing, mode checks, Linux/macOS lock support, bounded spool writer and version-1 archive writer/verifier using standard tar plus age. Generated regular file paths only; size and hash every entry. Verify all decrypted bytes through EOF, including age authentication beyond tar end markers; reject unexpected trailing plaintext. Check manifest and source count limits before allocating unbounded memory. Write `.partial`, close/fsync, rename to immutable bundle; remove failed temporary output and preserve an existing pending bundle.
- [ ] **Run GREEN:** `go -C backup-agent test ./...` and `go -C backup-agent vet ./...`. Expected: all archive/config/spool tests pass, no vet diagnostics.
- [ ] **Commit:** `feat: define encrypted backup bundles and named agent state`.

## Task 5: Docker PostgreSQL and exact-key S3 export adapters

**Files:** Create `backup-agent/{postgres.go,s3.go,export.go,postgres_test.go,s3_test.go,export_test.go}`; modify manifest/config types only if necessary to match the already specified fields.

**Interfaces:** `ExportPostgres(ctx context.Context, source PostgresSource, spool *Spool) (Export, error)`; `ExportBucket(ctx context.Context, source S3Source, spool *Spool) (Export, error)`; `ExportSources(ctx context.Context, cfg Config, spool *Spool, clientRunID string) (Export, error)`. Use injectable subprocess/S3 interfaces for tests; production subprocesses use argument arrays. S3 calls use AWS SDK v2 `ListObjectsV2` paginator and conditional `GetObject` with path-style addressing. Configure optional request/response checksum calculation to `WhenRequired` for Garage compatibility; do not assume its support for newer AWS checksum trailers. Body-hash verification remains our own SHA-256.

- [ ] **Write tests first:** `TestPostgresDumpFailurePreventsExport` injects nonzero exit and ensures no completed bundle; `TestPostgresNamesAreArguments` passes whitespace, quotes and leading `-` database names, checking explicit `--dbname` arguments and SQL-safe metadata queries. `TestPostgresCountsMatchExportSnapshot` changes source rows while exporting and requires the recorded table counts and dump to use the same exported snapshot. `TestBucketPaginationAndExactKeys` serves >1,000 keys from a local fake S3 endpoint, checking every key/body; `TestBucketChangesFailExplicitly` covers GET 404/412, size mismatch, opaque multipart ETags and stalled reads. `TestExportSpoolBoundedAndNoSecretsInErrors` checks caps and source URL/credential/stderr redaction.
- [ ] **Run RED:** `go -C backup-agent test ./...`. Expected: adapter tests fail against missing exporters.
- [ ] **Implement** bounded local export files and per-instance source summary. Query PostgreSQL server/client versions and installed extensions through `psql`. Keep a read-only repeatable-read `psql` session open, obtain `pg_export_snapshot()`, and give that snapshot to both `pg_dump -Fc --snapshot` and a second read-only `psql` session that collects per-application-table row counts. Generate count SQL with server-side identifier quoting (`format` with `%I`), never untrusted SQL interpolation; store counts in the manifest. Optionally run `pg_dumpall --globals-only` separately; abort on any required-source failure and always close the snapshot session. Snapshot consistency applies per database, not to globals or the bucket. Set per-job context timeout (two hours) and kill subprocesses/readers on cancellation. S3 export retains content type and exact key, verifies expected bytes and conditional-read validators; no normalization, recursive filesystem walk, source deletion or volume copying. Manifest time window encloses all exports.
- [ ] **Run GREEN:** `go -C backup-agent test ./...` (all adapters and earlier format tests pass).
- [ ] **Commit:** `feat: export Docker Postgres and Garage application data`.

## Task 6: Retryable upload lifecycle and named systemd installation

**Files:** Create `backup-agent/{upload.go,run.go,install.go,upload_test.go,run_test.go,install_test.go}`; modify `main.go`. Create `docs/backup-agent.md` with redacted configuration/CLI examples.

**Interfaces:** `UploadBundle(ctx context.Context, cfg Config, bundle Bundle) (RunSummary, error)`; `RunOnce(ctx context.Context, cfg Config) error`; `InstallInstance(cfgPath string, enableTimer bool) error`. CLI: `check --config FILE`, `run-once --config FILE`, `install --config FILE [--enable-timer]`, `version`. A new installation leaves the timer disabled by default. Recovery CLI is Task 7.

- [ ] **Write tests first:** `TestUploadResumesAfterLostResponses` fake server accepts chunk/finalization but drops response; ensure no duplicate run and resumed committed offset. `TestPendingBundleSurvivesRestart` simulates office outage, verifies only one encrypted pending bundle and no new source export until delivery. `TestStalePendingExportKeepsOriginalTime` asserts retry sends original manifest times. `TestRetryClassificationAndSecretRedaction` checks 401/403 stop, 429/5xx/network retry, bounded delays and redirect refusal. `TestTwoInstanceUnitsAndManualLock` checks separate config/state/locks, exact timer schedule/jitter and failure-only service restart after 30 minutes. `TestExpiredUploadReopensWithoutNewExport` checks a pending bundle resumes at zero after server expiration and keeps its original export time. No uninstall command is required in the pilot.
- [ ] **Run RED:** `go -C backup-agent test ./...`. Expected: lifecycle/installer tests fail.
- [ ] **Implement** locked sequence: retry pending → export sources → encrypt/hash → persist pending descriptor atomically → upload → verify server completion → delete local bundle/intermediates. On boot discard orphan partials, validate descriptor/bundle hashes and never treat unknown files as delivered. Source export proceeds before contacting the API when no pending bundle exists. Failure reports use safe error codes and clientRunId; queue one small report if offline. Retriable requests get four attempts with jittered waits based on 1, 2, 4 seconds, capped at 30 seconds including Retry-After; HTTP requests have a two-minute deadline. Throttle with `uploadBytesPerSecond` without allocating another bundle-sized buffer.
- [ ] **Implement** template oneshot unit with `Restart=on-failure`, `RestartSec=30min` and `StartLimitIntervalSec=0`, plus one persistent named daily timer with 600-second randomized delay. A successful oneshot is not periodically restarted; a failed source export or upload retries after 30 minutes, reusing any pending encrypted bundle first. No auto-update/shared binary replacement during jobs. Installer validates source jobs with `check` before enabling anything; clients can later explicitly enable their daily timer.
- [ ] **Run GREEN:** `go -C backup-agent test ./...` and `go -C backup-agent vet ./...` (all lifecycle/unit tests pass).
- [ ] **Commit:** `feat: deliver backups with independent systemd instances`.

## Task 7: Offline verification and explicit scratch restores

**Files:** Create `backup-agent/{restore.go,restore_test.go}`, `backup-agent/integration/restore_test.go`; modify `archive.go`, `main.go`, `docs/backup-agent.md`. Integration tests opt in with `FLATLINE_BACKUP_INTEGRATION=1`; they own uniquely named containers and never existing services.

**Interfaces:** `RestoreBundle(ctx context.Context, bundlePath, identityFile, targetConfigPath string) (RestoreReport, error)`; `CompareRestore(ctx context.Context, bundlePath, identityFile, targetConfigPath string) (RestoreReport, error)`. CLI: `verify --bundle FILE --identity-file FILE`; `restore --bundle FILE --identity-file FILE --target-config FILE`; `compare --bundle FILE --identity-file FILE --target-config FILE`; `keygen --output FILE` creates a non-overwriting 0600 identity and prints only the public recipient. Targets explicitly map source database/bucket to new database/container/S3 bucket. Globals require a separate `restore-globals` command with an explicit target.

- [ ] **Write tests first:** `TestRestoreRequiresEmptyExplicitTargets` rejects omitted/same configured source targets and populated buckets/databases; `TestRestoreVerifiesBeforeWriting` corrupts a late archive entry and asserts zero target writes. `TestRestoreKeysAndContentTypesExactly` checks each original key/body/content type, including `a` and `a/b`. `TestPartialRestoreNeverClaimsVerification` injects PUT/pg_restore failure and demands a failed report. `TestRecoveryDoesNotContactFlatline` runs with no API available. Integration `TestPostgres16AndGarageRoundTrip` verifies schema, fixed fixture table counts and every object key/size/SHA-256 against the manifest.
- [ ] **Run RED:** `go -C backup-agent test ./...`. Expected: recovery contract tests fail; Docker integration tests skip without the opt-in variable.
- [ ] **Implement** full archive pre-verification pass, then reread/decrypt and restore regular entries through explicit adapters (S3 PUT uses known Content-Length and a seekable bounded spool file to avoid unsupported aws-chunked encoding); no raw archive extraction. Check the bundle has not changed between passes; open one file descriptor and lock/private permissions while processing. Empty-target checks are necessary but do not authorize destructive cleanup; on partial failure leave scratch data for inspection. Use parameter-safe Docker/psql/pg_restore calls and recorded extension prerequisites. Produce a redacted JSON report; upload that report through the operator verification route only as a separate operator action. Archive verification alone never creates a passed restore report.
- [ ] **Run GREEN:** `go -C backup-agent test ./...`; then `FLATLINE_BACKUP_INTEGRATION=1 go -C backup-agent test ./integration -v` with Docker available. Expected: offline tests and actual fixture restore pass; record a missing Docker prerequisite explicitly rather than marking integration passed.
- [ ] **Commit:** `feat: verify and restore backups independently of Flatline`.

## Task 8: Display backup health and package the pilot

**Files:** Create `apps/dashboard/src/components/BackupAgents.tsx`, `apps/dashboard/src/lib/backup-presentation.ts`, `apps/dashboard/test/backups.test.mjs`, `backup-agent/integration/http_test.go`; modify `apps/dashboard/src/{components/MonitorDetail.tsx,lib/api.ts}`, `docker/rust.dockerfile`, `dev.sh`, `docs/{README,architecture,development,operations,backup-agent}.md`. Create opt-in `docker/compose.backups.yaml` for either root or office Compose. Add a separate backup-agent build stage and checksum file; do not replace telemetry VERSION/sha256sums.

**Interfaces:** In `api.ts`, `BackupAgentSummary`/`BackupRunSummary` match shared HTTP JSON; `fetchBackupAgents(monitorId?: number, signal?: AbortSignal)`, `fetchBackupRuns(agentId: string, signal?: AbortSignal)`, `downloadBackup(runId: string, signal?: AbortSignal)` use existing Authorization handling. In `backup-presentation.ts`, `backupHealth(agent: BackupAgentSummary): {label:string;tone:string}` and `verificationLabel(run: BackupRunSummary): string`. Component `BackupAgents({agents}:{agents:BackupAgentSummary[]})` is presentational; MonitorDetail loads linked agents in its existing snapshot to reuse one SSE connection and cancellation behavior. A protected manual provisioning runbook creates agents and handles credentials; no new fleet-control UI is required for the pilot.

- [ ] **Write tests first:** `backups.test.mjs` asserts separate MEKS/ZHKH rows, disabled/pending/failed/overdue labels and explicit `Transfer verified` versus `Restore tested`/`Not restore-tested`; stubs API to assert Authorization headers and binary downloads are not decoded as JSON. The Task 8 browser check deliberately delays the old monitor request and switches monitors to prove it cannot overwrite current backup rows. Rust tests assert each backup mutation publishes invalidate. Go opt-in HTTP integration launches a scratch backend on an ephemeral loopback port and exercises export/upload/download/offline verification/restore; two agents stay isolated.
- [ ] **Run RED:** `node --import=tsx --test apps/dashboard/test/backups.test.mjs` and focused Rust/Go integration tests. Expected: new behavior fails before implementation.
- [ ] **Implement** dense backup section using existing UI tokens, showing independent per-agent status, latest completed export, duration, bytes, counts, safe failure codes and restore results; distinguish older good recovery points from the latest failed attempt. Add per-agent bounded history display and authenticated download. Hide unused section when no agents are linked. Follow frontend-design and react-doctor skills at implementation time. Preserve monitor details if backup read fails, displaying a backup-specific error instead of blanking the page.
- [ ] **Implement** packaging and opt-in storage configuration. The opt-in Compose override sets `FLATLINE_BACKUP_DIR=/app/backups` and binds `${FLATLINE_BACKUP_HOST_DIR:-/mnt/mirror/flatline-backups}` to `/app/backups` with `create_host_path: false`; host preflight must confirm `/mnt/mirror` is mounted and its expected marker exists before enabling backup storage. Generic Compose leaves backups disabled unless explicitly configured; local dev uses a disposable test root with a marker and adjusted test free-space provider, never the office mount. Ship Linux amd64/arm64 backup binaries under a distinct directory; pilot deployment can transfer the checksum-verified binary directly over the existing SSH launcher, avoiding changes to telemetry download auth.
- [ ] **Run GREEN:** complete release checks listed below and local browser verification via T3 preview using a scratch backend/fixtures. Check two agents, failed backup, no restore test, monitor switching and live refresh. No production UI writes. Record verification results and update docs to describe the new separate Go module and storage setup.
- [ ] **Commit:** `feat: show backup recovery health and package the agent`.

## Task 9: Deploy and prove the MEKS pilot

**Files:** Update `docs/{backup-agent,deployment,history}.md` with redacted rollout facts and measured restore results; keep all credentials, key material, dumps and scratch state outside Git. Deployment checklist belongs in `docs/backup-agent.md` before live commands execute.

**Interfaces:** Existing modernization launcher and office SSH are authorized connection methods. The deploy artifact must be built from the reviewed feature commit, not the changing main checkout. No merge/push/shared-branch update is implied by this plan.

- [ ] **Preflight:** read modernization `AGENTS.md` and launcher instructions again before remote work. Confirm container names/versions, read-only source access, actual free space and current office running image/data paths. Inspect current main/office revisions to avoid deploying over the user's concurrent changes; if incompatible shared changes exist, stop and present the concrete integration choice. Never blindly sync with `--delete` or overwrite the main source tree.
- [ ] **Prepare recovery:** back up office SQLite using its online backup API and run integrity_check; retain the exact prior image and Compose configuration. Provision backup storage and marker only after confirming `/mnt/mirror` is the RAID1 mount. Generate age identity privately, store office copy 0600, and obtain/verify an independent private recovery copy through an authorized private transfer. If no independent recovery destination is available, keep daily timers disabled and request that specific missing detail.
- [ ] **Deploy receiver:** build/tag the feature image from a separate office source directory or transfer a locally built image, following the established deployment workflow. Apply the additive migration with monitoring downtime minimized; inspect existing health/telemetry/status pages immediately. Register MEKS linked to its actual existing monitor integer ID, save its dedicated token privately and configure the source with only its S3 credentials/public recipient. No credentials on command lines or in tool output.
- [ ] **Export once:** install named MEKS units with the daily timer disabled, run `check`, then `run-once`; measure local spool, network, office bytes and duration. Verify seven-point retention configuration and distinct agent identity. Do not configure a second live ZHKH backup during this pilot.
- [ ] **Prove recovery:** download the completed bundle and compare ciphertext SHA-256; run offline verify; restore into isolated PostgreSQL 16 and Garage containers on a scratch machine with explicit empty targets. Compare all keys/sizes/SHA-256, required extensions, schema and table counts. Compare restored table counts with the counts captured under the same exported PostgreSQL snapshot in Task 5, rather than with a changing production database. Any schema/extension/count/key/hash mismatch fails the restore test. Record archive and actual restore results separately through operator API.
- [ ] **Enable daily backup:** only after actual restore succeeds and recovery key copy exists, enable the MEKS daily timer. Verify `systemctl list-timers`, resulting 02:00 Asia/Almaty schedule/jitter, and backup row in Flatline. Exercise upload interruption locally, not by disrupting the live production service. Log measured size, duration, restore outcome and next scheduled run without secrets.
- [ ] **Commit:** `docs: record verified MEKS backup pilot` only after those facts are observed. If a live prerequisite fails, keep implementation complete but deployment explicitly incomplete; never claim the pilot is running.

## Verification and completion

Before code, baseline at `86dfe607` must be recorded. Before declaring implementation complete, run from this worktree:

```sh
npm run fmt:check
cargo test --locked --manifest-path backend-rs/Cargo.toml
npm run test:dashboard
npm run typecheck:dashboard
npm run build:dashboard
go -C superboard test ./...
go -C superboard vet ./...
go -C backup-agent test -race ./...
go -C backup-agent vet ./...
```

Cross-build backup agent with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` and `arm64` to ignored `.dev-data/backup-agent/`; run opt-in Docker/HTTP integration tests and build the complete Docker image. Use Node >=22.12 for Vite (this machine has Node 26; some npm shims invoke older Node, so resolve that explicitly if necessary). Format only changed Rust files; no repository-wide Rust reformat.

Perform the required whole-branch review after implementation, using the approved execution method, then address material findings with reproducing tests. Leave the feature branch/worktree available for review; do not merge the user's concurrent changes or remove their worktree automatically. Distinguish implementation checks, scratch integration and live pilot evidence in the final report.

## Planning references

- Repo conventions: `docs/development.md`; HTTP/state integration: `backend-rs/src/lib.rs`, `api/mod.rs`, `tests/common/mod.rs`.
- Event invalidation: `backend-rs/src/events.rs`; Telegram dispatch: `backend-rs/src/notify.rs`; existing detail snapshots: `apps/dashboard/src/components/MonitorDetail.tsx`.
- External APIs checked during planning: [age Go API](https://pkg.go.dev/filippo.io/age), [AWS SDK v2 S3](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/service/s3), [Tokio streamed reader](https://docs.rs/tokio-util/latest/tokio_util/io/struct.ReaderStream.html). Pin dependency versions when implementing; do not infer installation versions from these documentation pages.

## Worktree baseline (2026-10-20)

Verified at base `86dfe607` in `/Users/artchsh/.t3/worktrees/uptime-kuma/feature-backup-agent`, branch `feature/backup-agent`; the main checkout was not modified. Installed development dependencies only inside this worktree. Commands and observed results:

- `cargo test --locked --manifest-path backend-rs/Cargo.toml`: passed, 122 tests across 12 test targets, zero failures.
- `go test ./...` and `go vet ./...` in `superboard/`: passed; mock agent has no tests.
- Dashboard tests: passed, 45 tests, zero failures.
- Dashboard typecheck and production build: passed.
- `prettier --check .`: passed before adding this plan; the new plan also passed its targeted formatter check.
- npm installation initially warned about an older Node selected by a shim. Explicit Node 26 was used for dashboard verification; no dependency-version changes were made to suppress the warning.

The plan self-review maps every spec section to Tasks 1–9, checks common JSON/Go/Rust interfaces and covers all five Review Focus items. This document is a plan, not evidence of implemented backup behavior or a running pilot.
