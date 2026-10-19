# Named backup agents and the MEKS pilot

## Intent and scope

Provide daily, recoverable exports of application data on the office mirror,
with backup health visible in Flatline. A server can run one telemetry agent
and several independent backup agents. The first live agent is `meks`; a later
`zhkhteam` agent on the same host must need configuration only.

The approved pilot sources are Docker PostgreSQL and Docker Garage for MEKS.
System PostgreSQL and Docker MinIO are later adapters. Flatline clustering,
bucket policies, permissions, historical object versions, incremental storage,
point-in-time database recovery and automatic agent updates are outside this pilot.

Observed on 2026-10-19: `modernization-postgres-1` runs PostgreSQL 16 and holds
the 14 MB `modernization` database. `modernization-garage-1` runs Garage 1.0.1;
`meks-media` contains 1,372 objects totaling 885.1 MiB. The source has about
41 GB free. `/mnt/mirror` at the office is ext4 on a healthy two-member Linux
RAID1 array, with about 868 GiB available. It is not ZFS.

## Components and identity

- Add a standalone Go program in `backup-agent/`, separate from `superboard/`.
- Install one binary at `/usr/local/bin/flatline-backup`. Named instances use
  `flatline-backup@<name>.service`, with separate configuration at
  `/etc/flatline-backup/<name>.json` and state at
  `/var/lib/flatline-backup/<name>/`. Configurations are mode 0600; state is 0700.
- Each registered agent has a server-generated UUID, display name, optional
  server-monitor link, enable flag, expected backup interval, retention count
  and dedicated revocable credential. Store only the credential hash in SQLite.
  Credentials cannot access another agent's runs or operator APIs.
- Names are restricted to lowercase ASCII letters, digits, hyphens and
  underscores, 1–64 characters, beginning with a letter or digit. Storage uses
  server-generated UUIDs, never display names or submitted object keys.
- Multiple agents may link to one server monitor. Removing a monitor clears
  the link without deleting backup agents or stored recovery points.

## Configuration and scheduling

Each instance has its own Flatline HTTPS URL, credential file, age public
recipient, source jobs, local spool cap, schedule and network limits. Secrets
must not appear in CLI arguments, logs, reports, examples or Git. Source S3
credentials remain on the client; the office receiver never needs them.

Use a systemd oneshot service and a named persistent timer. The MEKS default is
02:00 Asia/Almaty daily, with up to ten minutes of jitter. A local per-instance
lock prevents timer and manual runs from overlapping. Stagger future agents.
Allow `check`, `run-once`, installation, verification and restore commands.
Schedules and source configuration remain local, so export creation does not
require the Flatline API to be online.

The pilot cap is 8 GiB for local spool and 8 GiB for each uploaded encrypted
bundle. Enforce the local cap while writing, including concurrent intermediate
files. Retain at most one pending encrypted bundle; retry delivery before
starting another export. Retry temporary network/server failures with bounded
backoff during a run; exit nonzero on unresolved failure so systemd retries
later. Configuration/authentication failures are reported without a tight loop.

## Export format and correctness

Produce one versioned tar bundle, encrypted using the maintained Go age library.
The source needs only the recovery public key. Keep the private key in a
root-only recovery location at the office and an independently saved recovery
copy. It is never stored in Flatline's database or sent to the source agent.

The archive contains a JSON manifest, custom-format PostgreSQL dumps, optional
cluster globals, and object bodies stored under generated numeric identifiers.
The manifest maps each object identifier to its exact bucket/key, size, SHA-256
and content type when present. Keys never become local filesystem paths. Empty
objects, Unicode, repeated slashes, dot segments, leading slashes, trailing
slashes and simultaneous keys `a` and `a/b` must round-trip without normalization.

Use the S3 API with path-style addressing and explicit pagination for Garage.
List current objects and GET each body; fail the export if a listed object
cannot be read. Check returned sizes and detect changes using available
conditional-read validators, treating ETags as opaque validators, not MD5 hashes.
Compute SHA-256 while reading. An active bucket is exported over a time window;
this is not an atomic bucket snapshot. Database and object exports also do not
share an application-wide transaction. Record start/end times and expose this
limitation in recovery documentation.

Execute `pg_dump -Fc` inside the explicitly configured PostgreSQL container.
Select database names explicitly and invoke subprocesses with argument arrays,
never shell interpolation. Optionally export globals using `pg_dumpall
--globals-only` when the configured role permits it. Record server/client
versions and required extensions. Exports do not copy live Docker volume files.
Each database dump is consistent independently; no cross-database consistency
is promised. Any required job failure prevents completion of the whole run.

## Receiver, upload and durability

Add backup APIs and metadata tables to the existing Rust backend. Operator APIs
register/revoke agents, list runs and download completed bundles. Agent APIs
start a run, upload numbered chunks, finalize a run and report a failure.
Document exact routes and request schemas in the implementation plan/OpenAPI.

The office uses a Cloudflare tunnel and binds Flatline to loopback. Therefore
upload encrypted bundles in resumable chunks of at most 8 MiB through the
existing HTTPS origin. Do not require a new public port or client VPN. Require
per-chunk SHA-256 and sequential offsets; duplicate retries with identical
bytes are idempotent, conflicting bytes/offsets are rejected. Completion
requires expected total size and SHA-256, fsync and atomic publication. A lost
final response must be safely retryable. Interrupted files remain incomplete
and never appear as successful backups.

Configure `FLATLINE_BACKUP_DIR` and mount
`/mnt/mirror/flatline-backups` into the Flatline container separately from its
SQLite data. Keep storage private. Stream uploads and downloads with bounded
memory. Enforce per-run and global capacity limits; retain at least 100 GiB free
on the office mirror. Serialize reservation/accounting so concurrent agents
cannot overcommit capacity. Reject new uploads if storage is unavailable; never
silently write to the container's root filesystem instead.

Seven completed daily recovery points are retained per agent. Failed and
incomplete runs do not consume that count or evict a completed backup. Expire
abandoned uploads after 48 hours, reporting expiration. Reconcile interrupted
finalization and deletion at startup. Retention runs server-side; agents cannot
delete older backups. Do not evict the last good backup to make a new run fit.

## Health and operator experience

Add a backup section to the existing server detail view showing each linked
agent independently: last completed export time, run state, duration, uploaded
bytes, source counts, last error and most recent restore verification. Operator
APIs also list unlinked agents. Publish configuration/run changes through the
existing event mechanism so the dashboard refreshes after updates.

A successful upload means transfer-verified, not restore-tested. Show these as
separate states. Alert through the server monitor's existing Telegram channels
on a failed run or no completed export for 36 hours, with persisted transition
state to prevent restart spam. Notify recovery after a completed run. Disabled
agents do not generate overdue alerts. On first registration, allow 36 hours
before an overdue alert. A disconnected agent must still become overdue.

## Recovery and pilot rollout

Provide an offline-capable command to decrypt a downloaded bundle and verify
every manifest entry/hash, rejecting unexpected archive paths or duplicate
entries. Restore objects to an explicitly supplied empty target bucket using
the exact original keys and recorded content types. Restore databases to an
explicitly supplied scratch target using `pg_restore`; globals restoration is
separate and opt-in. Never default to overwriting the live source.

Before enabling the daily timer, run one MEKS export, transfer it to the office,
download and verify it, then restore into an isolated PostgreSQL 16 instance
and a separate Garage bucket. Compare all object keys, sizes and body hashes;
check database schema and application table counts. Record actual restore
results in Flatline, separately from archive checks. Keep scratch restore writes
off production data and existing users. Inspect and back up Flatline's own
SQLite database before deploying its migration, following existing operations
documentation. Do not change the `zhkh` stack in this pilot.

## Verification requirements

Test multiple instances and credential isolation; exact-key round trips and
pagination; PostgreSQL subprocess failure; bounded spool/memory; interrupted
and duplicate chunk uploads; hash mismatch; receiver restart; capacity races;
retention preserving successful backups; overdue alerts without agent reports;
and restoration independent of the Flatline API. Run the repository's required
backend/dashboard checks and the new Go module's tests, vet and Linux builds.
Do not claim recoverability until the isolated restore actually succeeds.
