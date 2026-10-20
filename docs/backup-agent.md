# Flatline backup agent

`flatline-backup` is a separate Go program that exports application data from
one Docker host, encrypts it locally and uploads it to Flatline over the
existing HTTPS origin. It is independent of the telemetry agent: one host may
run `superboard` and several named backup agents.

## Install

```sh
install -m 0755 flatline-backup /usr/local/bin/flatline-backup
install -d -m 0700 /etc/flatline-backup /var/lib/flatline-backup/meks
install -m 0600 meks.json /etc/flatline-backup/meks.json
flatline-backup check --config /etc/flatline-backup/meks.json
flatline-backup install --config /etc/flatline-backup/meks.json
systemctl daemon-reload
```

`install` writes the named `flatline-backup@meks.service` and
`flatline-backup@meks.timer`. The timer stays disabled until the operator adds
`--enable-timer`, which runs `systemctl daemon-reload` and
`systemctl enable --now flatline-backup@meks.timer` (linking it into
`timers.target` and starting it) and fails the install if either command
fails. Do not enable it before a restore has been proven.

## Configuration

```json
{
  "version": 1,
  "name": "meks",
  "serverUrl": "https://uptime.example",
  "tokenFile": "/etc/flatline-backup/meks.token",
  "recipient": "age1...",
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

The config, token file, S3 credentials file and age identity must be mode 0600. The state directory must end with the instance name and be mode 0700.
Remote endpoints require HTTPS; cleartext is accepted only for a literal
loopback address. Database names and bucket names must be unique within one
instance so restore targets are unambiguous.

The age private key never exists on this host. Only the public `recipient`
does. A separate development-host test may use a generated identity.

## Commands

- `check --config FILE` validates configuration and local secret file modes.
- `run-once --config FILE` retries one pending bundle first, otherwise exports,
  encrypts, persists a pending descriptor and uploads. The daily timer runs it.
- `install --config FILE [--enable-timer]` writes the named service and timer;
  `--enable-timer` also enables and starts the timer through systemctl.
- `version` prints the binary version.

A pending encrypted bundle is retained until the server reports completion;
the next run retries it without re-exporting. Failed exports are reported with
a bounded safe error code (never stderr). Temporary network failures retry
with bounded backoff; authentication failures stop immediately.

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
randomized delay, `Persistent=true` and `WantedBy=timers.target`. A successful oneshot is not restarted;
a failed source export or upload retries after 30 minutes and reuses any
pending encrypted bundle first.

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

At most one pending encrypted bundle exists per instance. Local spool and
bundle caps default to 8 GiB, including concurrently retained intermediate
files. Upload chunks are at most 8 MiB. The office receiver keeps 100 GiB free
and seven completed recovery points per agent.

Recovery documentation and the exact restore procedure arrive with the
restore command; transfer verification is not a restore test.

## Recovery

Recovery is offline: it needs the downloaded bundle and the age identity, not
Flatline.

```sh
flatline-backup keygen --output /secure/recovery-identity.txt
flatline-backup verify --bundle bundle.age --identity-file recovery-identity.txt
flatline-backup restore --bundle bundle.age --identity-file recovery-identity.txt \
  --target-config restore-target.json
flatline-backup compare --bundle bundle.age --identity-file recovery-identity.txt \
  --target-config restore-target.json
```

`keygen` writes a new mode-0600 identity and prints only the public recipient.
Keep the private identity off the source host; `restore` never contacts Flatline.
`verify` checks every manifest entry, hash, size, exact key, content type and
object mapping, rejects trailing plaintext and returns only the validated
manifest. Archive verification is not a restore test.

`restore-target.json` maps every source database and bucket to an explicit
scratch target. Missing, identical or populated targets are refused before any
write:

```json
{
  "version": 1,
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

Objects are PUT to the exact original keys with recorded content types. A
partial failure leaves scratch data for inspection and reports `restoreStatus:
failed`; it never claims verification. The `compare` command checks every
object key/size and each database's table counts against the manifest.

Globals are never restored implicitly. Use the separate command with an
explicit globals target:

```sh
flatline-backup restore-globals --bundle bundle.age --identity-file identity.txt \
  --target-config restore-target.json
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
