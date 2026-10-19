# Add a project to Flatline monitoring

> **For AI agents and the humans supervising them.** Follow this workflow
> when asked to monitor a project, website or server. Fetch this document
> fresh for each onboarding: it ships with the deployed Flatline backend.
> The origin, supplied credential and available agent version below are
> substituted by the server; project names, URLs and IDs must be discovered.

- **Flatline origin**: {{ORIGIN}}
- **Supplied credential**: `{{TOKEN}}`
- **Available host-agent version**: {{AGENT_VERSION}}
- **Source repository**: https://github.com/qarasky/flatline

If Claude, Codex or another agent cannot determine whether a capability is
supported, inspect the source repository rather than guess. Start with
`docs/api.md` and `backend-rs/src/api/openapi.json`, then check the relevant
handlers in `backend-rs/src/api/`, host-agent code in `superboard/`, or
dashboard code in `apps/dashboard/src/`. Trace accepted inputs and actual
behavior; a field name or UI control alone does not prove support.

The repository's default branch may differ from the deployed instance.
Use the matching deployed revision/tag when known, and check the instance's
`/api/v1/openapi.json` and observed API responses. The host-agent version
above is not the backend revision. If support cannot be confirmed for the
deployed version, report that uncertainty and the source evidence; do not
claim the capability is available or change Flatline itself as part of
project onboarding.

## 1. Establish access and scope

This document is reachable with a valid token, without a dashboard login.
It contains a credential: do not commit it, paste it into public chats or
include it in tickets or completion reports.

There are two independent credentials:

- **Operator token**: full permission to manage the Flatline instance.
  Operator API calls require `Authorization: Bearer {{TOKEN}}`.
- **Push token**: belongs to one push monitor. It lets that host send
  telemetry and download agent updates; it cannot manage monitors.

Either kind can fetch this runbook and `/agent/*`, using a bearer header
or `?token=...`. Successfully fetching this document does **not** prove
that the supplied credential can provision monitors. Check first:

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/auth/me"
```

If this returns 401, stop operator API work and ask the operator for a
valid operator credential through their private credential channel. Do
not try to turn a push token into an operator token. Keep the operator
credential in the provisioning environment; hosts only need their push
tokens. Once a push monitor exists, its push token can also fetch the
installer and downloads.

Before creating anything, inspect the current project's README,
deployment configuration, Compose files, reverse-proxy configuration and
available environment configuration. Do not print secrets. Establish:

- Project name and intended environment: production, staging or another
  explicitly requested deployment.
- Deployed hosts, how to access them, and whether hosts are shared with
  other projects. The current shell may be a development machine.
- Public website/API URLs and a suitable health endpoint for each.
- Existing Flatline group and notification destination, if identifiable.

Use evidence already available; ask the human only about unresolved
choices. Do not infer deployment ownership solely from a matching name,
DNS address or group. Do not install on the current machine unless it is
confirmed to be the target host.

### What to monitor

- **Host health**: one `push` monitor and one `superboard` agent per host.
  Reuse these when multiple projects share a host. Host telemetry alone
  does not establish that the application works.
- **Application availability**: HTTP/HTTPS monitors for the agreed URLs,
  checked from the Flatline server, independently of the host agent.
- **Organization**: `group` monitors contain other monitors using `parent`.
- **Hosting association**: link website monitors to their host's push
  monitor (§5). Sharing a group does not create a website link.

A website-only request may need no host agent. A project spanning several
hosts may need several host monitors. Unsupported application checks
must be reported as a gap, not silently replaced with a weaker check.

## 2. Discover and match existing monitors

**Look before creating.** List monitors, including paused ones:

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors?perPage=200&page=1"
```

Read `pagination.hasMore` and increment `page` until false. A single page
is not the whole inventory. `?q=...` searches name and URL by substring;
URL-encode the query and paginate those results too. Search results are
candidates, not proof of identity.

Match candidates using all available evidence:

- Hosts: monitor type, display name, group path and the target host's
  existing `/etc/superboard/config.json` (`server_url`, `push_token`).
  Compare credentials privately; do not log or report them.
- Websites: type, URL including health path, environment and group path.
  A homepage monitor and a readiness monitor may intentionally coexist.
- Groups: reconstruct full paths through `parent`; names may repeat.

If several candidates fit, ask which to reuse. A paused monitor is not
permission to resume it. Reuse matching monitors and preserve unrelated
settings. Never create a replacement simply because an API call timed out:
search again before retrying a create, since the original may have succeeded.

Record IDs as you go. The examples below use shell variables such as
`SERVER_ID`, `WEBSITE_ID` and `GROUP_ID`: set them from discovery or create
responses, in the shell running that step. They are not literal IDs and
are not automatically shared with an SSH session. Never copy an ID from
an unrelated example.

### Choose organization and alerts before creating

Groups have `type: "group"`. Reuse the intended path; if a new group is
needed, create it with its actual name and optional parent:

```bash
# Set GROUP_NAME from the agreed project/environment name first.
GROUP_BODY=$(jq -n --arg name "$GROUP_NAME" '{name:$name,type:"group"}')
curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d "$GROUP_BODY"
```

Save `monitor.id` as `GROUP_ID`. For a nested group, include the discovered
parent ID. Omit `parent` for top level. Group status follows children
(worst-of; paused children ignored; empty groups pending); no extra group
check is needed.

Find the intended active notification destination:

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/notifications"
```

Do not assume notification ID `1` exists or is appropriate. Do not assume
a group's alert assignments are inherited by its children. Configure each
monitor's `notificationIDList` explicitly when alerts are required.
An array replaces all existing assignments. On existing monitors, add a
destination with the object form, for example `{"notificationIDList":{"42":true}}`
using the actual discovered ID; this preserves other assignments. Setting
that ID to `false` removes it. Unknown IDs can be skipped. Monitor read
responses currently omit notification assignments, so read-back cannot
verify delivery configuration. Record the requested IDs, confirm they
exist and are active, and report this verification limitation unless an
operator can independently confirm the assignments/delivery. Do not
intentionally trigger a production outage to test alerts.

## 3. Create only the missing monitors

The shell examples use `curl` and `jq` in the provisioning environment.
Set the named variables from the agreed inventory first. Check HTTP
status, JSON `ok`, returned monitor fields and `ignoredFields`. On failure,
inspect the response body (for example, use `curl --fail-with-body` where
available); `curl -f` alone suppresses the error body.

### Host push monitor

Skip creation if §2 found the correct monitor. For a missing host, set
`HOST_NAME` to its hostname, `GROUP_ID` to its chosen group and
`NOTIFICATION_IDS` to a JSON array of selected IDs (or `[]` if no alerts
were requested):

```bash
SERVER_BODY=$(jq -n --arg name "$HOST_NAME" \
  --argjson parent "$GROUP_ID" --argjson alerts "$NOTIFICATION_IDS" \
  '{name:$name,type:"push",interval:20,maxretries:2,retryInterval:180,
    parent:$parent,notificationIDList:$alerts}')
SERVER_RESPONSE=$(curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d "$SERVER_BODY")
printf '%s\n' "$SERVER_RESPONSE" | jq '{ok,ignoredFields,monitorId:.monitor.id}'
SERVER_ID=$(printf '%s\n' "$SERVER_RESPONSE" | jq -er '.monitor.id')
PUSH_TOKEN=$(printf '%s\n' "$SERVER_RESPONSE" | jq -er '.monitor.pushToken')
```

For top-level monitors use JSON `null` for `GROUP_ID`. Keep the full
response private: it contains the host's push token. Reused push monitors
expose the same token via `GET /api/v1/monitors/{id}`; no token rotation is
needed for a reinstall.

These are the fleet's existing scheduling recommendations, not a 20-second
alert guarantee. The agent samples every second; `interval:20` is the
silence watchdog. With `maxretries:2` and `retryInterval:180`, sustained
silence normally takes roughly six minutes to reach DOWN and notify.
Choose a different policy explicitly if the project needs faster alerts.
The API requires a monitor interval of at least 20 seconds; keep it at
least three times the agent's configured sample interval.

### Website or API HTTP monitor

Choose an endpoint that represents the intended service. A homepage can
show that the web server responds; a health/readiness endpoint may test
application dependencies. Agree which behavior matters and what status
codes count as success.

Checks originate from **Flatline**, so `localhost`, a Docker service name
or a private address is usable only if it reaches the intended service
from Flatline's network. A working request from the project host does not
prove that Flatline can reach it.

For each missing website, set `WEBSITE_NAME`, `WEBSITE_URL`, `GROUP_ID`
and `NOTIFICATION_IDS`:

```bash
WEBSITE_BODY=$(jq -n --arg name "$WEBSITE_NAME" --arg url "$WEBSITE_URL" \
  --argjson parent "$GROUP_ID" --argjson alerts "$NOTIFICATION_IDS" \
  '{name:$name,type:"http",url:$url,interval:60,parent:$parent,
    notificationIDList:$alerts}')
WEBSITE_RESPONSE=$(curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d "$WEBSITE_BODY")
printf '%s\n' "$WEBSITE_RESPONSE" | jq '{ok,ignoredFields,monitorId:.monitor.id}'
WEBSITE_ID=$(printf '%s\n' "$WEBSITE_RESPONSE" | jq -er '.monitor.id')
```

`type:"http"` supports HTTPS URLs. Useful fields: `method`,
`accepted_statuscodes` (default `["200-299"]`), `ignoreTls`,
`maxredirects`, `timeout` (default 80% of `interval`), `upsideDown`.
Do not disable TLS validation merely to make a check pass.

Unsupported fields are ignored and returned in `ignoredFields`:
`keyword`, `invertKeyword`, `jsonPath`, `expectedValue`, `headers`, `body`,
`basic_auth_user`, `basic_auth_pass`, `bearer_token`. If the required check
needs authentication, response-body validation or another unsupported
capability, report the limitation and ask for an appropriate health
endpoint or agreed alternative. Do not claim that check is configured.

## 4. Install or reuse the host agent

Skip this section for website-only onboarding. Run host commands on the
**target host**, not automatically on Flatline or the development machine.

Preflight: confirm Linux amd64/arm64, root/sudo access, `bash`, `curl`,
`sha256sum`, and outbound HTTPS to {{ORIGIN}}. Prefer systemd. Without it,
the agent installs an `@reboot` cron entry and starts now, but cron does
not restart a crashed agent. Ensure cron is available if using that path.

Check for an existing binary, service/process and config before installing.
Choose the correct case:

- **Agent exists and its config points to the correct Flatline monitor:**
  reuse it; verify telemetry first. Update only if needed.
- **Monitor exists, agent absent:** use that monitor's push token for a
  fresh install. An existing monitor does not imply an existing agent.
- **No monitor and no agent:** create the push monitor in §3, then install.
- **Agent points to a different monitor or Flatline instance:** resolve
  ownership before changing it. The installer preserves existing config,
  even when passed a different `--token`; rerunning it does not reassign
  the host. Do not overwrite a shared host's monitoring configuration.

### Fresh install

Transfer only the selected host's push token through the private host
access channel. Set `PUSH_TOKEN` in the target host's shell, then run:

```bash
curl -fsSL "{{ORIGIN}}/agent/install.sh?token=$PUSH_TOKEN" | sudo bash -s -- \
  --server '{{ORIGIN}}' --token "$PUSH_TOKEN"
```

The installer selects the architecture, downloads and verifies SHA-256,
installs `/usr/local/bin/superboard`, writes `/etc/superboard/config.json`
(mode 0600), and starts the agent through systemd or the cron fallback.
A previous binary is kept as `/usr/local/bin/superboard.bak`.

### Update an existing install

Agents 1.7+ self-update by default: first check about two minutes after
startup, then every 24 hours. Updates require systemd, verify checksums,
keep the previous binary, and roll back if the new service fails to start.
`sudo superboard self-update --check` reports what is available.

Older agents need one manual update. With `PUSH_TOKEN` set to the token
already configured on the host:

```bash
curl -fsSL "{{ORIGIN}}/agent/install.sh?token=$PUSH_TOKEN" | sudo bash -s -- --update
```

This preserves config and replaces the binary. `--update` without config
fails. On non-systemd hosts, restart the running agent under the host's
actual process-management setup; replacing the file does not restart the
existing process. Check `superboard version` and fresh telemetry afterward.

## 5. Link websites to the hosts that serve them

Website linkage is an existing feature. It associates HTTP/HTTPS monitors
with a server's card; it does not create checks, change group membership,
configure notifications or introduce an alert dependency. A linked website
that is down gives the server card a red border; pending websites degrade
its presentation too. This is separate from the push monitor's host status.

For each host, link only the websites it serves. Confirm the relationship
from deployment evidence; do not link every project website to every host
by default. A shared website may appropriately link to several hosts.

### Read, merge, replace, verify

`PUT /api/v1/monitors/{id}/links` **replaces the entire link set**. To add
one website while preserving existing associations, use `SERVER_ID` for
the host's push monitor and `WEBSITE_ID` for the existing/new HTTP monitor:

```bash
EXISTING_LINKS=$(curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/links")
LINK_BODY=$(printf '%s\n' "$EXISTING_LINKS" | jq -ce --argjson id "$WEBSITE_ID" \
  'if .ok == true and (.raw | type) == "array"
   then {linkedMonitorIds:([.raw[].linkedMonitorId] + [$id] | unique)}
   else error("Cannot read existing links") end')
curl -fsS -X PUT "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/links" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d "$LINK_BODY"
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/links"
```

Inspect `ok` and compare returned links with the intended set. Abort on a
failed read or merge; never send an empty fallback body. Re-read immediately
before saving if another operator may be editing links: this API has no
atomic append or conflict detection.

- `raw`: stored targets with `linkedMonitorId`. Preserve these IDs when
  merging, including any group IDs.
- `resolved`: concrete HTTP/HTTPS monitors with `id`, `url`, `status` and
  `via` (the direct monitor or group that supplied the association).
- A group target dynamically expands through nested groups to all their
  HTTP/HTTPS monitors, including future additions. Link a group only when
  that whole set is appropriate for the host. Do not replace raw group
  links with their resolved website IDs: that loses future additions.
- Push/ping targets, self-links and nonexistent target IDs are skipped;
  duplicates collapse. A successful response alone does not prove every
  requested website was linked. Check `raw` and `resolved`.
- Up to 200 target IDs may be submitted. `[]` clears all links.

## 6. Verify and report the result

Read each created or reused monitor back using its actual ID:

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID"
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/metrics/latest"
curl -fsS -H "Authorization: Bearer {{TOKEN}}" \
  "{{ORIGIN}}/api/v1/monitors/$WEBSITE_ID"
```

Run only calls relevant to the requested scope. Confirm:

1. Correct names, types, environment/group paths, URLs and active state.
   Review any `ignoredFields` from writes. Check selected notification
   destinations are active; distinguish requested assignments from
   independently verified delivery (see §2).
2. Hosts are UP with recent, advancing telemetry from the intended machine,
   not merely an old sample. Check the host's service/process and logs if
   telemetry is stale. Version output or an installer exit alone is not
   proof that pushes arrive.
3. Websites have completed a check from Flatline and are UP for the agreed
   endpoint/status policy. Allow at least a configured check interval;
   poll with a bounded deadline, not indefinitely.
4. Website links preserve previous raw targets and resolve to the intended
   website IDs. Check the server card if dashboard access is available.

Status codes: `0` DOWN, `1` UP, `2` pending, `3` maintenance. Pending can mean
no first result **or** retrying a failure; inspect recent heartbeats and
messages rather than treating all pending states as installation delays.

Report the project/environment, hosts and website URLs, monitor IDs and
group paths, what was created versus reused, agent installation/update
results, verified website associations, requested notification assignments and
any independently confirmed delivery.
Include failed checks, unsupported requirements and missing host access.
If installation was handed to an operator, label it awaiting installation;
do not report onboarding as fully verified. Never include tokens or config
contents in the report.

## 7. Maintenance and API reference

Operator API successes normally return `{"ok":true,...}`; errors normally
return `{"ok":false,"error":"...","message":"..."}`. Downloads return
scripts/binary/text, and the push endpoint uses `msg` for errors. A 401
means the credential is missing, invalid or inactive for that endpoint.
A 400 usually explains rejected input. Do not blindly retry validation
failures or non-idempotent creates.

### Modify, pause or remove

PATCH only the fields that need changing. `type` is immutable. `parent`
moves a monitor to a group, or `null` moves it to top level. Pausing keeps
history but disables pushes/download access using that monitor's push token.

```bash
# Set MONITOR_ID to the discovered monitor to change.
curl -fsS -X PATCH "{{ORIGIN}}/api/v1/monitors/$MONITOR_ID" \
  -H "Authorization: Bearer {{TOKEN}}" -H "Content-Type: application/json" \
  -d '{"active":false}'
# Resume with {"active":true}; move with {"parent":<actual group ID or null>}.
```

**Deletes, uninstalls and removals of existing associations require explicit
human confirmation.** To delete a monitor, use
`DELETE /api/v1/monitors/{id}`. Deleting a group without
`?deleteChildren=true` preserves its children and moves them to its parent
or top level; the flag deletes the whole subtree. Check the affected IDs
before deleting. `DELETE /api/v1/monitors/{id}/links` clears all website
links. Removing a host also requires `sudo superboard uninstall` on that
host; this removes its agent configuration and local buffer. Do not
uninstall a shared host's agent when removing just one project.

### Supported writable monitor fields

Unknown fields are ignored and returned in `ignoredFields` on monitor
create/PATCH. This mechanism does not validate website-link targets.

| Fields | Meaning |
| --- | --- |
| `name`, `description`, `active` | Display name, free text, pause switch |
| `type` | `http`, `https`, `push`, `ping`, `group`; create only |
| `interval` | Seconds, 20–86400 |
| `retryInterval`, `maxretries`, `timeout`, `resendInterval` | Scheduling; timeout defaults to 80% of interval |
| `parent`, `weight` | Group ID (or null), ordering weight (higher first) |
| `url`, `method`, `accepted_statuscodes`, `ignoreTls`, `maxredirects` | HTTP checks |
| `hostname`, `packetSize`, `pingCount`, `pingNumeric`, `pingPerRequestTimeout` | Ping checks |
| `pushToken` | Push credential; generated automatically, re-readable |
| `metricCpuThreshold`, `metricRamThreshold`, `metricDiskThreshold` | Telemetry alert percentages; 60s sustained, 5-point recovery; separate from host DOWN |
| `notificationIDList` | Notification assignments; array replaces existing set |

For a ping monitor use `type:"ping"` and `hostname` (IP or DNS name).
It checks ICMP reachability, not application health.

Other useful endpoints (operator bearer authentication):

- `GET /api/v1/monitor-types` — supported types and writable fields.
- `GET /api/v1/health` — fleet summary.
- `GET /api/v1/monitors/{id}/heartbeats?limit=100` — recent checks/messages.
- `GET /api/v1/monitors/metrics/latest?ids=1,2` — batched latest telemetry;
  replace the example IDs with discovered IDs.
- `GET /api/v1/monitors/links?ids=1,2` — batched website links.
- `GET /api/v1/openapi.json` — full API document (public).

## 8. Troubleshooting and downloads

| Symptom | Check / action |
| --- | --- |
| Runbook loads but operator API returns 401 | Supplied token may be a push token; provisioning needs an active operator token. |
| Agent push returns 404 | Monitor deleted/paused or wrong push token. Read monitor `active` and `pushToken` privately. |
| No host telemetry or pending status | On the target: `sudo superboard check`, service/process status, and `journalctl -u superboard -n 50` on systemd. Check `server_url` and outbound HTTPS. Avoid posting verbose payloads/config publicly. |
| Monitor turns down after working | Inspect heartbeat messages and host logs for network/DNS failure. Buffered samples may arrive late; confirm fresh telemetry. |
| Website fails while host is UP | Check application health, URL, TLS and reachability from Flatline; host UP does not imply website UP. |
| Website link missing after PUT | Check target type/ID, `raw` and `resolved`; invalid targets may be skipped. Group must actually contain HTTP/HTTPS monitors. |
| Checksum mismatch | Retry the download; if persistent, have the operator verify matching binaries/checksums and proxy behavior. Do not bypass verification. |
| Updated file but old agent still running | Check the running service/process and restart behavior; non-systemd updates need manual process restart. Self-update may have rolled back. |
| Existing config ignored the new token | Installer preserves config. Resolve ownership and explicitly plan reassignment; another install command does not change it. |

Downloads accept an operator token or an active monitor's push token via
bearer header or `?token=...`. All URLs below require authentication:

- Installer: `{{ORIGIN}}/agent/install.sh?token={{TOKEN}}`
- Version/builds/hashes: `{{ORIGIN}}/agent/version?token={{TOKEN}}`
- Checksums: `{{ORIGIN}}/agent/sha256sums?token={{TOKEN}}`
- Linux amd64: `{{ORIGIN}}/agent/superboard-linux-amd64?token={{TOKEN}}`
- Linux arm64: `{{ORIGIN}}/agent/superboard-linux-arm64?token={{TOKEN}}`

Only builds shipped by the deployed instance are available. Dashboard:
{{ORIGIN}}. The runbook is embedded in the backend binary: publishing an
updated runbook requires rebuilding and deploying that backend.
