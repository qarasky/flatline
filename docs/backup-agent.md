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
`--enable-timer`; do not enable it before a restore has been proven.

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

The config, token file, S3 credentials file and age identity must be mode
0600. The state directory must end with the instance name and be mode 0700.
Remote endpoints require HTTPS; cleartext is accepted only for a literal
loopback address. Database names and bucket names must be unique within one
instance so restore targets are unambiguous.

The age private key never exists on this host. Only the public `recipient`
does. A separate development-host test may use a generated identity.

## Commands

- `check --config FILE` validates configuration and local secret file modes.
- `run-once --config FILE` retries one pending bundle first, otherwise exports,
  encrypts, persists a pending descriptor and uploads. The daily timer runs it.
- `install --config FILE [--enable-timer]` writes the named service and timer.
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
Restart=on-failure
RestartSec=30min
```

The timer uses `OnCalendar=*-*-* 02:00:00 Asia/Almaty`, a 600-second
randomized delay and `Persistent=true`. A successful oneshot is not restarted;
a failed source export or upload retries after 30 minutes and reuses any
pending encrypted bundle first.

## Limits

At most one pending encrypted bundle exists per instance. Local spool and
bundle caps default to 8 GiB, including concurrently retained intermediate
files. Upload chunks are at most 8 MiB. The office receiver keeps 100 GiB free
and seven completed recovery points per agent.

Recovery documentation and the exact restore procedure arrive with the
restore command; transfer verification is not a restore test.
