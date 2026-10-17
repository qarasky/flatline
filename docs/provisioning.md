# Flatline provisioning runbook

> **For LLM agents (and the humans supervising them).** This document is
> served by the Flatline server with the access token and origin already
> substituted, so every command below is copy-paste ready. Fetch it fresh
> whenever you provision: it ships with the deployed server version.

- **Server**: {{ORIGIN}}
- **Access token**: `{{TOKEN}}`
- **Agent version available**: {{AGENT_VERSION}}

The token is a credential. Send it as `Authorization: Bearer {{TOKEN}}` on
every API call, or as `?token={{TOKEN}}` on the download endpoints. Do not
paste this document into public chats, repositories or tickets.

## Ground rules

1. **Look before you create.** Never create a duplicate monitor. Search
   first (`GET {{ORIGIN}}/api/v1/monitors?perPage=200` or `?q=<name>`). If
   the monitor already exists, reuse it — its `pushToken` is in the JSON —
   and jump to installing/updating the agent (§1.5).
2. **Ask the human when unsure.** Which group? Which display name? Never
   guess silently on ambiguous or destructive choices.
3. **One response shape.** Every endpoint answers `{"ok":true,...}` or
   `{"ok":false,"error":"...","message":"..."}`. A 401 means the token is
   wrong or disabled; a 400 carries a `message` naming the rejected field.
4. **Only supported fields take effect.** Anything else is ignored and
   listed back in `ignoredFields` — always check it, and never assume a
   field was accepted (see §7 for the full list).
5. **Deletes need explicit human confirmation.**

## 1. Add a push server (the usual job)

### 1.1 Find the group

Groups are monitors with `"type":"group"`; `parent` nests them. Build the
path from the chain (e.g. `work / MEKS`) to show the human.

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors?perPage=200" \
  | python3 -c 'import json,sys; [print(m["id"], m["name"], "parent=", m.get("parent")) for m in json.load(sys.stdin)["monitors"] if m["type"]=="group"]'
```

### 1.2 Create the monitor

```bash
curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d '{
    "name": "server-01",
    "type": "push",
    "interval": 20,
    "maxretries": 2,
    "retryInterval": 180,
    "parent": 56,
    "notificationIDList": [1]
  }'
```

- `name` — what the dashboard shows; use the hostname.
- `interval` — the down watchdog: no push for `interval` seconds means the
  monitor starts failing. The agent pushes telemetry every second, so 20s
  is comfortable. Recommended with `maxretries: 2` and
  `retryInterval: 180`, matching the rest of the fleet.
- `parent` — group id from §1.1 (omit for top level).
- `notificationIDList` — ids from §6 (Telegram alerts).

Response (`201 Created`):

```json
{"ok":true,"monitor":{"id":61,"name":"server-01","type":"push","status":2,"pushToken":"pt_xxxxxxxx", "...":"..."},"ignoredFields":[]}
```

**Save `monitor.id` and `monitor.pushToken`.** The push token is the
per-host credential the agent pushes with.

### 1.3 Install the agent on the target host (as root)

Run this **on the server being monitored**, not on the Flatline server. If
you have no shell access there, hand this exact command to the operator:

```bash
curl -fsSL '{{ORIGIN}}/agent/install.sh?token={{TOKEN}}' | sudo bash -s -- \
  --server {{ORIGIN}} --token <PUSH_TOKEN>
```

The script detects the architecture, downloads the agent, verifies its
sha256, installs `/usr/local/bin/superboard`, writes
`/etc/superboard/config.json` (0600) and the systemd unit, and starts the
service. A previous binary is kept as `/usr/local/bin/superboard.bak`.

Success ends with `superboard {{AGENT_VERSION}}` and `active`.

### 1.4 Verify

The monitor stays `"status": 2` (pending) until the first push lands —
usually seconds after the service starts.

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" "{{ORIGIN}}/api/v1/monitors/61"
# Wait for "status": 1 (up). Then confirm telemetry:
curl -fsS -H "Authorization: Bearer {{TOKEN}}" "{{ORIGIN}}/api/v1/monitors/61/metrics/latest"
```

If it stays pending, see §8.

### 1.5 Update the agent on an existing host

Agents **1.7 and newer update themselves**: once a day (default), and on
start, they ask the server for the latest release and install it — checksum
verified, previous binary kept, service restarted, and an automatic rollback
if the new build does not come up. Updates require systemd; agents on hosts
without it log the available release and wait for a manual update. Check
what a host would do with `sudo superboard self-update --check`.

To update by hand (or to force it on a non-systemd host), use the same URL
with `--update`: config and push token stay, only the binary is replaced and
the service restarted.

```bash
curl -fsSL '{{ORIGIN}}/agent/install.sh?token={{TOKEN}}' | sudo bash -s -- --update
```

The script also auto-detects an existing install (config present) and
updates it without the flag; `--update` with no config is an error rather
than a half-install. Compare `superboard version` on the host with
`{{ORIGIN}}/agent/version` to confirm.

### 1.6 Re-provision, move, or remove a host

- The push token is re-readable any time:
  `GET /api/v1/monitors/{id}` → `pushToken`. Use it to reinstall without
  recreating the monitor.
- Full reinstall: `sudo superboard uninstall`, then the §1.3 command.
- Removing a server: delete the monitor (§5) and run `sudo superboard
  uninstall` on the host.

## 2. Add an HTTP(s) monitor

```bash
curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d '{"name":"example.com","type":"http","url":"https://example.com/health","interval":60,"parent":55,"notificationIDList":[1]}'
```

Useful fields: `url`, `method` (`GET`, `POST`, …), `accepted_statuscodes`
(`["200-299"]` by default), `ignoreTls`, `maxredirects`, `timeout`
(defaults to 80% of `interval`), `upsideDown`.

Not implemented in this backend — they are ignored, not errors:
`keyword`, `invertKeyword`, `jsonPath`, `expectedValue`, `headers`,
`body`, `basic_auth_user`, `basic_auth_pass`, `bearer_token`. Check
`ignoredFields` if you tried one.

## 3. Add a ping (ICMP) monitor

```bash
curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d '{"name":"gateway","type":"ping","hostname":"10.0.0.1","interval":60,"parent":53}'
```

Fields: `hostname` (IP or DNS name), `packetSize` (default 56),
`pingCount`, `pingPerRequestTimeout`.

## 4. Groups

```bash
# Create a group; parent nests it under another group
curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" -d '{"name":"MEKS","type":"group","parent":53}'

# Move a monitor into a group, or out (null)
curl -fsS -X PATCH "{{ORIGIN}}/api/v1/monitors/61" -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" -d '{"parent":56}'

# Rename
curl -fsS -X PATCH "{{ORIGIN}}/api/v1/monitors/56" -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" -d '{"name":"MEKS-KZ"}'

# Delete just the group: re-parent its children first, then DELETE without
# the flag (children keep working, they move to the group's parent or top
# level). Delete the whole subtree in one request:
curl -fsS -X DELETE "{{ORIGIN}}/api/v1/monitors/56?deleteChildren=true" \
  -H "Authorization: Bearer {{TOKEN}}"
```

Group monitors are containers: their status follows their children
(worst-of; paused children are ignored; a child without beats counts as
pending; an empty group is pending). They are checked automatically — do
not add a separate check.

## 5. Pause, resume, delete

```bash
curl -fsS -X PATCH "{{ORIGIN}}/api/v1/monitors/61" -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" -d '{"active":false}'   # pause (history kept)
curl -fsS -X PATCH "{{ORIGIN}}/api/v1/monitors/61" -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" -d '{"active":true}'    # resume
curl -fsS -X DELETE "{{ORIGIN}}/api/v1/monitors/61" -H "Authorization: Bearer {{TOKEN}}"
```

## 6. Telegram notifications

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" "{{ORIGIN}}/api/v1/notifications"
# {"ok":true,"count":1,"notifications":[{"id":1,"name":"MBG Alerts","type":"telegram","active":true,...}]}
```

Link a monitor by putting the notification id in `notificationIDList` on
create or PATCH. Alerts arrive in this shape:

```text
[🔴 DOWN] [work / MEKS] [server-01]
[push] [server-01]
[No heartbeat in the time window]
[CPU 12% · RAM 43% · Disk / 71% · Load 0.42]
```

The last line exists for push monitors only (last telemetry). The line
above it is the failure reason.

## 7. Field reference

Writable fields on create/PATCH (anything else → `ignoredFields`):

| Field | Notes |
| --- | --- |
| `name`, `description`, `active` | display name, free text, pause switch |
| `type` | `http`, `https`, `push`, `ping`, `group` (create only) |
| `interval` | seconds, 20–86400 |
| `retryInterval`, `maxretries`, `timeout`, `resendInterval` | scheduling; timeout defaults to 80% of interval |
| `upsideDown` | alert when UP instead of down |
| `parent`, `weight` | group id, ordering weight (higher first) |
| `url`, `method`, `accepted_statuscodes`, `ignoreTls`, `maxredirects` | HTTP checks |
| `hostname`, `packetSize`, `pingCount`, `pingNumeric`, `pingPerRequestTimeout` | ping checks |
| `pushToken` | push monitors; server-generated, re-readable |
| `metricCpuThreshold`, `metricRamThreshold`, `metricDiskThreshold` | push telemetry alerts (percent; 60s sustained, 5-point recovery) |
| `notificationIDList` | notification ids to link |

Monitor status codes: `0` down, `1` up, `2` pending, `3` maintenance.

Other read endpoints worth knowing:

- `GET /api/v1/health` — fleet summary counts.
- `GET /api/v1/monitors/{id}/heartbeats?limit=100` — recent checks.
- `GET /api/v1/monitors/metrics/latest?ids=1,2` — latest telemetry, batched.
- `GET /api/v1/openapi.json` — the full API document.

## 8. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Agent push answers `404` | Monitor deleted, paused, or the push token is wrong. `GET /api/v1/monitors/{id}` to check `active` and re-read `pushToken`. |
| Monitor stays `status: 2` | No push arrived. On the host: `systemctl status superboard`, `journalctl -u superboard -n 50`. Check the config's `server_url` reaches `{{ORIGIN}}`. |
| Monitor flips down after working | Network path or DNS from the host; the agent buffers samples on disk (`/var/lib/superboard/buffer`) and delivers late. Check `journalctl`. |
| `install.sh` checksum failure | Download was truncated; rerun. If it persists, the served binary is being rebuilt — retry in a minute. |
| Update did not change the version | The service did not restart: `systemctl restart superboard`, then `superboard version`. |
| `superboard install` says "already installed" | Use the §1.5 update path; `install` is for fresh hosts only. |
| 401 from any endpoint | Token wrong/disabled. The operator can re-enable or mint one in the dashboard's Agents panel. |

## 9. Downloads and version

- Installer: `{{ORIGIN}}/agent/install.sh?token={{TOKEN}}`
- Binaries: `{{ORIGIN}}/agent/superboard-linux-amd64`,
  `{{ORIGIN}}/agent/superboard-linux-arm64`
- Checksums: `{{ORIGIN}}/agent/sha256sums`
- Version + hashes (JSON): `{{ORIGIN}}/agent/version?token={{TOKEN}}`
- Dashboard: {{ORIGIN}}
