# Flatline backup agent

`flatline-backup` is a separate Go program that exports application data from
one Docker host, optionally encrypts it locally and uploads it to Flatline
over the existing HTTPS origin. It is independent of the telemetry agent: one host may
run `superboard` and several named backup agents.

## Install

```sh
install -m 0755 flatline-backup /usr/local/bin/flatline-backup
install -d -m 0700 /etc/flatline-backup /var/lib/flatline-backup/meks
install -m 0600 meks.json /etc/flatline-backup/meks.json
flatline-backup check --config /etc/flatline-backup/meks.json
flatline-backup install --config /etc/flatline-backup/meks.json
```

`install` writes the named `flatline-backup@meks.service` and
`flatline-backup@meks.timer`, plus the host's `flatline-backup-update.service`
and `.timer` (see [Self-update](#self-update)), runs `systemctl daemon-reload`
and enables the self-update timer. The backup timer stays disabled until the
operator adds `--enable-timer`, which also runs
`systemctl enable --now flatline-backup@meks.timer` (linking it into
`timers.target` and starting it). A failing systemctl fails the install. Do
not enable the backup timer before a restore has been proven.

## Configuration

```json
{
  "version": 1,
  "name": "meks",
  "serverUrl": "https://uptime.example",
  "tokenFile": "/etc/flatline-backup/meks.token",   # flatline_agent_backup_...
  "recipient": "age1...",                           # optional; omit for plain bundles
  "stateDir": "/var/lib/flatline-backup/meks",
  "spoolMaxBytes": 8589934592,
  "uploadBytesPerSecond": 0,
  "schedule": "*-*-* 02:00:00 Asia/Almaty",
  "postgres": [
    {
      "container": "modernization-postgres-1",
      "user": "postgres",
      "databases": ["modernization"],
      "includeGlobals": false
    }
  ],
  "s3": [
    {
      "endpoint": "http://127.0.0.1:3900",
      "region": "garage",
      "bucket": "meks-media",
      "credentialsFile": "/etc/flatline-backup/meks-s3.json"
    }
  ]
}
```

The config, token file, S3 credentials file and age identity (when used) must be mode 0600. The state directory must end with the instance name and be mode 0700.
Remote endpoints require HTTPS; cleartext is accepted only for a literal
loopback address. Database names and bucket names must be unique within one
instance so restore targets are unambiguous.

### Encryption

Encryption is **off by default**: without `recipient` every bundle is a plain
tar archive (`<run>.tar` in the spool, downloaded as `.tar`). Set `recipient`
to an age X25519 public key for sensitive data and every bundle is
age-encrypted instead (`.age`). A `recipient` that is present but malformed is
refused at `check`, never silently treated as "off". `check` prints which mode
an instance is in, and the dashboard marks encrypted runs.

A plain bundle is protected in transit by HTTPS and at rest only by the office
host's disk permissions. Its integrity rests on the per-entry SHA-256 in the
manifest, the manifest-last rule and the receiver's whole-bundle hash; an
encrypted bundle adds age's authenticated stream on top.

With encryption on, the age private key never exists on this host. Only the
public `recipient` does. Losing the private key makes every bundle encrypted
to it unrecoverable. A separate development-host test may use a generated
identity.

Each run reports `encrypted` in its source summary; the server stores it and
names downloads by it. Runs from agents that predate optional encryption have
no flag and are treated as encrypted.

## Commands

- `check --config FILE` validates configuration and local secret file modes.
- `run-once --config FILE` retries one pending bundle first, otherwise exports,
  encrypts when configured, persists a pending descriptor and uploads. The daily timer runs it.
- `install --config FILE [--enable-timer]` writes the named service and timer
  and the host's self-update units, and enables the self-update timer;
  `--enable-timer` also enables and starts the backup timer through systemctl.
- `install --refresh-units` re-renders every installed instance's units and the
  self-update units from their configs and runs `daemon-reload`, without
  changing which timers are enabled. A newly installed build runs it.
- `self-update` checks in for every installed instance and installs a newer
  build when the server ships one. The self-update timer runs it.
- `version` prints the binary version.

A pending bundle is retained until the server reports completion;
the next run retries it without re-exporting. Failed exports are reported with
a bounded safe error code (never stderr). Temporary network failures, 408,
429 and 5xx (including 503 when the office cannot check the credential)
retry with bounded backoff and honour `Retry-After`; 401/403 stop
immediately.

Undelivered bundles are reported too, under a derived clientRunId per bundle
and code, so the bundle's own server run stays resumable: `upload_failed`, or
`office_storage_full` for a 507. A later delivery of the same bundle clears
the failure.

`POST /api/backup/v1/runs` answers 409 with a machine-readable `error`:

- `active_run`: another run of this agent is still uploading. The pending
  bundle is kept. If that run has a different clientRunId, this instance no
  longer holds its bundle, so the agent abandons it once
  (`POST /api/backup/v1/runs/{id}/abandon`) and retries; if the run is busy
  the next scheduled attempt tries again.
- `params_conflict` / `run_terminal`: the bundle can never be delivered under
  its clientRunId. Only these move it to `quarantine/` and start a fresh
  export.

`quarantine/` keeps at most two bundles and at most one `spoolMaxBytes` of
data (oldest pruned first, on every run), and every quarantine is reported as
`bundle_quarantined`, which the office alerts on. Worst-case local disk use is
therefore two spool caps.

## One-shot service

```ini
[Unit]
StartLimitIntervalSec=0
[Service]
Type=oneshot
ExecStart=/usr/local/bin/flatline-backup run-once --config /etc/flatline-backup/meks.json
TimeoutStartSec=6h
Restart=on-failure
RestartSec=30min
```

`TimeoutStartSec=6h` covers the two-hour export deadline plus a throttled
upload of a maximum-size bundle; a oneshot otherwise has no start timeout, and
a hung run would keep the timer from ever firing again.

The timer uses `OnCalendar=*-*-* 02:00:00 Asia/Almaty`, a 600-second
randomized delay, `Persistent=true` and `WantedBy=timers.target`. A
successful oneshot is not restarted; a failed source export or upload retries
after 30 minutes and reuses any pending bundle first.

## Self-update

The backup agent updates itself on its **own version line** (`0.x`,
`const version` in `backup-agent/main.go`), independent of the telemetry
agent. The binary is shared by every instance on a host, so updating is per
host: `flatline-backup-update.timer` runs `flatline-backup self-update` daily
(`OnCalendar=daily`, `RandomizedDelaySec=3600`, `Persistent=true`), whether
or not any backup timer is enabled.

Each run:

1. Finds the installed instances from the `flatline-backup@<name>.service`
   units (their `--config` path), not from the config directory, which also
   holds credentials files.
2. Checks in for **every** instance with that instance's token
   (`POST /api/backup/v1/checkin`), reporting the running version and the
   previous run's outcome. The server records both per agent; the Superboard
   shows the version after the telemetry agent's.
3. Stops with `server_mismatch` if the instances report to different
   servers, `downgrade_refused` if the server ships an older build, `no_asset`
   if it ships none for this platform; does nothing when already current.
4. Downloads the build to `/var/lib/flatline-backup/update/` (0700) and
   requires its size, sha256 and its own `version` output to match the
   release (`checksum_mismatch`, `version_mismatch`).
5. Takes every instance's run lock, waiting up to 30 minutes for a running
   backup (`lock_timeout` past that). The swap never happens under a backup.
6. Copies the current binary to `/usr/local/bin/flatline-backup.prev`, renames
   the new build into place, releases the locks, then runs the new build's
   `install --refresh-units` and lets it check in with its new version.

Every outcome other than `ok` is reported at once and again on the next
check-in, as `updateStatus` on the agent. The service exits non-zero on a
failure, so `systemctl --failed` and `journalctl -u flatline-backup-update`
show it.

- **Opt out** on a host by creating `/etc/flatline-backup/self-update.disabled`
  (any content). The timer keeps running and still reports the version; it
  never downloads or swaps.
- **Roll back** by hand:
  `mv /usr/local/bin/flatline-backup.prev /usr/local/bin/flatline-backup`, then
  create the opt-out file so the next check does not reinstall the release.
- **First hop:** builds before 0.3.0 have no self-update. Install 0.3.0 by
  hand once and re-run `install --config …` for each instance so the update
  units are written; from then on the host updates itself.

## What a bundle contains

| Included                                                 | Not included                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| Each configured Postgres database (`pg_dump -Fc`)        | Postgres roles and other globals, unless `includeGlobals: true`    |
| Every object of each configured S3/Garage bucket, by key | Garage itself: `garage.toml`, layout, bucket settings, access keys |
| A manifest with per-entry size and SHA-256, table counts | The application: compose files, `.env` secrets, container images   |

A restore therefore needs a running Postgres and S3 service to restore into;
rebuilding a host also needs its application configuration from elsewhere.

## Where bundles are stored

On the receiving Flatline server, under `FLATLINE_BACKUP_DIR` (office:
`/mnt/mirror/flatline-backups`, the RAID1 mirror):
`agents/<agent-id>/<run-id>/bundle.tar` (plain) or `bundle.age` (encrypted),
from the run's `encrypted` flag, owned by the service user, mode 0700
directories. Servers before 2026-10-25 stored every bundle as `bundle.age`;
those files keep downloading and are deleted normally. The server keeps
`retentionCount` (default seven) completed runs per agent plus the latest
restore-tested and archive-verified runs, and deletes the rest.

## Consistency of one bundle

A bundle is not a single point-in-time snapshot of the whole application:

- Each PostgreSQL database is dumped from one exported snapshot, and its
  recorded table counts come from the same snapshot. Different databases,
  globals and the bucket are captured at different moments.
- The S3 bucket is read object by object while the application keeps
  writing. An object listed but deleted before it could be read is recorded
  under `vanished` in the manifest and is not restored; an object that
  changed after listing (ETag/size/412) still fails the export.
- A database row can therefore reference an object that is missing from the
  bundle (deleted during the export) or miss an object uploaded after the
  dump. Restore checks report `vanished` counts; reconcile references in the
  application if that matters.

Fresh exports are capped at four per UTC day (the scheduled run plus
retries after failures); the cap is reported once as
`export_attempts_exhausted` and resets after a successful delivery or at the
next UTC day. Retrying a pending bundle does not count.

## Limits

At most one pending bundle exists per instance. Local spool and
bundle caps default to 8 GiB, including concurrently retained intermediate
files. Upload chunks are at most 8 MiB. The office receiver keeps 100 GiB free
and `retentionCount` (default seven) completed recovery points per agent, plus
the latest run with a passed restore test and the latest with a passed archive
verification, whatever their age.

Transfer verification (the receiver's full SHA-256 check at completion) is not
a restore test; see [Recovery](#recovery) for the restore procedure.

## Receiver behaviour

- Chunk bodies are read with a 30-second idle and a five-minute total
  deadline (408), at most four at a time; waiting more than 30 seconds for a
  slot or for the per-run lock answers 503 `busy` with `Retry-After`. Accepted
  connections use TCP keepalive.
- Hashing, fsync, rename and unlink run on the blocking thread pool. The
  bundle is hashed once at completion; boot reconciliation of an interrupted
  finalization hashes it once too.
- The chunk, completion and download routes form their own router group
  (`api::backups::transfer_routes`), exempt from the 30 s request timeout
  (completion hashes up to 8 GiB); they enforce the body deadlines above
  instead. The agent control calls (`agent_routes`) take the normal budget.
  On shutdown the maintenance loop and in-flight body reads are cancelled.
- Alerts go to the Telegram notifications linked to the agent's monitor,
  through the same rate-limited per-chat queue as monitor alerts. An
  agent without a monitor (never linked, or its monitor was deleted) or whose
  monitor has no Telegram link alerts the default notifications instead.
- Backup changes publish a `{"type":"backups"}` live event, not the generic
  `invalidate`; the dashboard reloads backup rows only on that event, on
  mount and after a reconnect.

## Downloads

The dashboard asks for `POST /api/v1/backup-runs/{id}/download-ticket` and
navigates to the returned `/api/v1/backup-downloads/{ticket}` URL, so the
browser streams the bundle to disk. A ticket names one completed run,
expires after two minutes, works once and exists only in memory (a restart
voids it). Scripts can still use `GET /api/v1/backup-runs/{id}/download` with
the operator `Authorization` header.

## Recovery

Recovery is offline: it needs the downloaded bundle (and, for an encrypted
bundle, the age identity), not Flatline. The format is detected from the
file: `--identity-file` is required for a `.age` bundle and ignored for a
`.tar` one.

```sh
# plain bundle
flatline-backup verify --bundle bundle.tar
flatline-backup restore --bundle bundle.tar --target-config restore-target.json
flatline-backup compare --bundle bundle.tar --target-config restore-target.json

# encrypted bundle
flatline-backup keygen --output /secure/recovery-identity.txt   # once, when enabling encryption
flatline-backup verify --bundle bundle.age --identity-file recovery-identity.txt
flatline-backup restore --bundle bundle.age --identity-file recovery-identity.txt \
  --target-config restore-target.json
flatline-backup compare --bundle bundle.age --identity-file recovery-identity.txt \
  --target-config restore-target.json
```

`keygen` writes a new mode-0600 identity and prints only the public recipient,
which goes into the config as `recipient`. Keep the private identity off the
source host; `restore` never contacts Flatline. `verify` checks every manifest
entry, hash, size, exact key, content type and object mapping, rejects
trailing data and returns only the validated manifest. Archive verification is not a restore test.

`restore-target.json` maps every source database and bucket to an explicit
scratch target. Missing, identical or populated targets are refused before any
write:

```json
{
  "version": 1,
  "tempDir": "/srv/restore-scratch",
  "postgres": [
    {
      "container": "scratch-postgres",
      "user": "postgres",
      "databases": [{ "source": "modernization", "target": "restore_check" }]
    }
  ],
  "s3": [
    {
      "endpoint": "http://127.0.0.1:3901",
      "region": "garage",
      "sourceBucket": "meks-media",
      "bucket": "meks-media-restore",
      "credentialsFile": "/etc/flatline-backup/restore-s3.json"
    }
  ]
}
```

`tempDir` (optional, absolute, an existing real directory) holds each
decrypted entry, up to 8 GiB, while it is verified and restored; put it on the
target's disk, not on a tmpfs. Without it a private `.flatline-restore-*`
directory next to the bundle is used. Either way it is mode 0700 and removed
afterwards.

Objects are PUT to the exact original keys with recorded content types. A
partial failure leaves scratch data for inspection and reports `restoreStatus:
failed`; it never claims verification. The `compare` command checks every
object key/size and each database's table counts against the manifest.

### Integration tests

`FLATLINE_BACKUP_INTEGRATION=1 go -C backup-agent test ./integration -v`
runs the opt-in tests. The PostgreSQL round-trip needs Docker and the
`postgres:16` image. The Garage round-trip additionally needs
`FLATLINE_BACKUP_GARAGE_ENDPOINT` (loopback HTTP is accepted),
`FLATLINE_BACKUP_GARAGE_ACCESS_KEY_ID`, `FLATLINE_BACKUP_GARAGE_SECRET_ACCESS_KEY`,
`FLATLINE_BACKUP_GARAGE_SOURCE_BUCKET` and `FLATLINE_BACKUP_GARAGE_TARGET_BUCKET`
(optional `FLATLINE_BACKUP_GARAGE_REGION`, default `garage`): two dedicated
scratch buckets, the target empty. It seeds exact keys (`a`, `a/b`, `x//y`,
Unicode, an empty object) under a unique prefix, runs `run-once`, `verify`,
`restore` and `compare`, checks every key, size, SHA-256 and content type, and
deletes what it wrote. Missing prerequisites skip; they never pass.

Globals are never restored implicitly. Use the separate command with an
explicit globals target:

```sh
flatline-backup restore-globals --bundle bundle.tar --target-config restore-target.json
# encrypted: add --identity-file identity.txt
```

## Packaging

The backend image builds both Linux backup binaries under `/app/backup-agent`:

- `flatline-backup-linux-amd64`
- `flatline-backup-linux-arm64`
- `VERSION-BACKUP`
- `sha256sums-backup`

These are separate from the telemetry agent's `/app/agent` files. The opt-in
`docker/compose.backups.yaml` override sets `FLATLINE_BACKUP_DIR=/app/backups`
and bind-mounts `${FLATLINE_BACKUP_HOST_DIR:-/mnt/mirror/flatline-backups}`
with `create_host_path: false`. Without the override, backup storage stays
disabled and upload starts answer 503. Local `dev.sh` creates a disposable
`.dev-data/backend-backups` root with its own marker; it never uses the office
mirror.

The host must already have the directory and its
`.flatline-backup-storage` marker containing a provisioned UUID. The backend
never creates the root or falls back to the container filesystem.
