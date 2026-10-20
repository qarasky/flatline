# AI-assisted push-agent deployment

> **For AI agents and the humans supervising them.** This document is the
> whole onboarding workflow: analyse a server, install or reuse the host
> agent, then (with operator access) add website monitors, group them and
> link them to the host.
>
> Fetch it fresh for every onboarding: it ships with the deployed Flatline
> backend and the origin, credential, token family and agent version below
> are substituted by the server.

- **Flatline origin**: {{ORIGIN}}
- **Supplied credential**: `{{TOKEN}}`
- **Credential kind**: `{{TOKEN_KIND}}` (`{{TOKEN_PREFIX}}...`)
- **Host push monitor**: {{MONITOR_ID}} (`{{MONITOR_NAME}}`)
- **Available host-agent version**: {{AGENT_VERSION}}
- **Source repository**: https://github.com/qarasky/flatline

The credential in this link is one of two families:

| Prefix                   | Kind              | Can do                                                       | Cannot do                           |
| ------------------------ | ----------------- | ------------------------------------------------------------ | ----------------------------------- |
| `flatline_op_`           | Operator          | GUI sign-in, every `/api/v1` call, mint more operator tokens | Send telemetry; act as a host agent |
| `flatline_agent_push_`   | Push (host) agent | `/api/push/{token}`, `/agent/*`, this runbook                | Call `/api/v1`, sign in to the GUI  |
| `flatline_agent_backup_` | Backup agent      | `/api/backup/v1` only                                        | Anything in this runbook            |

Legacy `flatline_...` tokens minted before the split still work and are
resolved by the store that holds them. Do not create new ones.

If a credential is used on the wrong surface, the API answers explicitly
instead of a bare 401 — for example `agent_token_on_operator_api` with a
`hint` and the expected prefix. Read `error`, `message` and `hint`; the
`hint` names the fix. Do not guess or retry the same wrong family.

**Never paste a token into a public chat, ticket, commit, log or completion
report.** Keep it in an environment variable in the provisioning shell.

If this document, `/api/v1/openapi.json` or the source could disagree with
the deployed instance, prefer the instance's responses. Do not modify
Flatline itself as part of a project onboarding.

---

## 1. Understand the request and the server

The human supplies three things: this link, access to the target server,
and the websites that must be monitored. Establish the rest from evidence
before changing anything.

Inspect the target host (do not print secrets):

- Whether a Superboard agent already exists: `/usr/local/bin/superboard`,
  `/etc/superboard/config.json` (mode 0600), `systemctl status superboard`,
  `superboard version`.
- What runs on the host: `docker ps`, Compose files, reverse-proxy configs,
  listening ports, systemd units. A server often hosts several projects.
- Which public domains and subdomains actually point at this host, and which
  health endpoint proves the application works (not only that nginx runs).
- Whether this is the intended host at all. The current shell may be a
  development machine; do not install on it unless confirmed.

Then decide, and state the plan in one short message before changing
anything:

- **One host, one push monitor.** If an agent already exists and points to
  the Flatline monitor in this link, reuse it. If it points elsewhere, stop
  and ask — never silently reassign a shared host.
- **Several projects on one host.** They share one push monitor and one
  agent. Their websites still get their own HTTP monitors.
- **Several hosts.** Each host needs its own push monitor and agent; a
  website link belongs to the host that serves it.

Ask the human only about unresolved choices, for example: which projects on
a shared server are in scope, the agreed health URL for an application, or
whether an existing monitor should be reused. Do not ask for anything you
can discover safely yourself.

If the credential kind is `push_agent`, this link already names the host
monitor: **#{{MONITOR_ID}} (`{{MONITOR_NAME}}`)**. Installing the agent with
this token joins the host to that monitor. The operator API is closed to
this credential; you will request an operator token in §3, after the agent
is running.

---

## 2. Install or reuse the host agent

Skip the install if the request is website-only.

Preflight on the target: Linux amd64/arm64, root or sudo, `bash`, `curl`,
`sha256sum`, and outbound HTTPS to {{ORIGIN}}. Prefer systemd; without it
the installer writes an `@reboot` cron entry, which does not restart a
crashed agent.

### Fresh install

The installer needs **two different things**: a credential to download the
binary, and the monitor's **push token** to configure the agent. They are the
same only when this link carries a push-agent token.

- **Link carries `flatline_agent_push_...`**: use it for both; the monitor is #{{MONITOR_ID}}.
- **Link carries `flatline_op_...`**: first find or create the host's push
  monitor and take its `pushToken` (never put the operator token in the
  agent config):

```bash
SERVER_RESPONSE=$(curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer $FLATLINE_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg name "$HOST_NAME" '{name:$name,type:"push",interval:20,maxretries:2,retryInterval:180}')")
SERVER_ID=$(printf '%s\n' "$SERVER_RESPONSE" | jq -er '.monitor.id')
SERVER_PUSH_TOKEN=$(printf '%s\n' "$SERVER_RESPONSE" | jq -er '.monitor.pushToken')
```

Reuse an existing host monitor instead when one matches. Then install with
the push token as the config credential (it also authorizes the download):

```bash
curl -fsSL "{{ORIGIN}}/agent/install.sh?token=$SERVER_PUSH_TOKEN" \
  | sudo bash -s -- --server '{{ORIGIN}}' --token "$SERVER_PUSH_TOKEN"
```

For a push-token link the same command with `{{TOKEN}}` in both places is
correct. Do **not** run the installer with an operator token as `--token`:
that would write a full-permission credential to the host.

The script selects the architecture, downloads the binary, verifies its
SHA-256 against the server's `sha256sums`, installs `/usr/local/bin/superboard`,
writes `/etc/superboard/config.json` (0600), starts the service and prints
the version. It keeps any previous binary as `superboard.bak`.

Check before and after:

```bash
sudo superboard version
systemctl is-active superboard
sudo journalctl -u superboard -n 30 --no-pager
sudo superboard check        # one collection + push; "ok" means accepted
```

### Reuse or update an existing install

- Agents 1.7+ self-update: first check shortly after start, then every 24h.
  `sudo superboard self-update --check` reports what the server ships.
- Older agents need one manual hop, with the host's existing push token:

```bash
curl -fsSL "{{ORIGIN}}/agent/install.sh?token=<host-push-token>" \
  | sudo bash -s -- --update
```

`--update` keeps config and token, replaces the binary, refreshes the
systemd unit, health-checks the new build and rolls back on failure.

Read the host's token privately from its config when updating; never print
it. An existing config is preserved even if `--token` differs, so do not
try to reassign a host by rerunning the installer.

Do not continue to §3 until the host monitor's telemetry is actually
arriving: run `superboard check`, then confirm the monitor is UP with fresh
data. A successful installer exit or `version` alone is not proof.

---

## 3. Obtain operator access

Needed only when this link carries a **push-agent** token. If it carries an
operator token, verify it and continue:

```bash
curl -fsS -H "Authorization: Bearer {{TOKEN}}" "{{ORIGIN}}/api/v1/auth/me"
```

The response must say `"tokenKind":"operator"`. If it answers
`agent_token_on_operator_api`, the credential is a host-agent token: ask
the human for an operator token through their private credential channel.
A ready-to-send request:

> The agent is installed and reporting, and I need to configure websites
> and notifications. Please mint an operator token in Flatline →
> Agents → API keys (prefix `flatline_op_`) and send it through the private
> channel. I will use it only for this onboarding and will not store it in
> the repository or in shell history.

Do not ask for an operator token before the agent works, and never try to
turn an agent token into one. Keep the operator token in `FLATLINE_TOKEN`
in the provisioning shell:

```bash
export FLATLINE_TOKEN='flatline_op_...'
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" "{{ORIGIN}}/api/v1/auth/me"
```

---

## 4. Inventory before creating anything

### Monitors

```bash
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/monitors?perPage=200&page=1"
```

Read `pagination.hasMore` and increment `page` until false. `?q=...`
searches names and URLs. Search results are candidates, not proof of
identity. Match on type, URL including path, group path and host evidence.

### Notification destinations

```bash
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/notifications"
```

- **Exactly one active destination**: use it unless the human said
  otherwise.
- **More than one**: list them to the human (id, name, type, active) and
  ask which one should receive this project's alerts. Do not guess.
- **None**: report that alerts cannot be configured and ask how to proceed.

Notification assignments are per monitor and are not inherited from groups.
Assign each monitor explicitly with `notificationIDList`; an array replaces
the full set, the object form (`{"42":true}`) merges into an existing set.
Read responses omit assignments, so record what you sent and report the
verification limit instead of claiming delivery was proven.

---

## 5. Create only the missing website monitors

Prefer reusing an existing monitor whose URL and purpose match. Never create
a duplicate because a response was slow — search again first.

Choose an endpoint that proves the application works. A homepage proves the
web server responds; a health/readiness endpoint proves more. Agree with the
human which behavior matters. Checks run from the Flatline server, so
`localhost` or a Docker service name is usable only if Flatline can reach it
from its own network.

For each missing domain or subdomain:

```bash
WEBSITE_BODY=$(jq -n --arg name "$WEBSITE_NAME" --arg url "$WEBSITE_URL" \
  --argjson parent "$GROUP_ID_OR_NULL" --argjson alerts "$NOTIFICATION_IDS" \
  '{name:$name,type:"http",url:$url,interval:60,parent:$parent,
    notificationIDList:$alerts}')
WEBSITE_RESPONSE=$(curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer $FLATLINE_TOKEN" -H "Content-Type: application/json" \
  -d "$WEBSITE_BODY")
printf '%s\n' "$WEBSITE_RESPONSE" | jq '{ok,ignoredFields,monitorId:.monitor.id}'
WEBSITE_ID=$(printf '%s\n' "$WEBSITE_RESPONSE" | jq -er '.monitor.id')
```

`type:"http"` also covers HTTPS. Useful fields: `method`,
`accepted_statuscodes` (default `["200-299"]`), `ignoreTls`,
`maxredirects`, `timeout` (default 80% of `interval`), `upsideDown`.
Do not disable TLS validation just to make a check pass.

Unsupported fields are ignored and returned in `ignoredFields`: `keyword`,
`invertKeyword`, `jsonPath`, `expectedValue`, `headers`, `body`,
`basic_auth_user`, `basic_auth_pass`, `bearer_token`. If the required check
needs authentication or body validation, report the gap and ask for an
agreed health endpoint instead.

### Group the websites created for one server

If you create **two or more** website monitors for domains/subdomains served
by the same host, create one group named after the project or host and put
all of them in it:

```bash
GROUP_RESPONSE=$(curl -fsS -X POST "{{ORIGIN}}/api/v1/monitors" \
  -H "Authorization: Bearer $FLATLINE_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg name "$GROUP_NAME" '{name:$name,type:"group"}')")
GROUP_ID=$(printf '%s\n' "$GROUP_RESPONSE" | jq -er '.monitor.id')
```

Set `parent` to that group ID when creating each website monitor (or PATCH
an existing monitor's `parent` into it). A single website can stay at the
project's existing group or top level. Groups follow the worst child state;
do not add a check to a group.

---

## 6. Link the websites to the host push monitor

Website linkage puts sites on the host's card; it does not change groups,
notifications or alert dependencies. Link the **group** when you created
one, so future additions are covered automatically. Link the individual
website when there is only one.

`PUT /api/v1/monitors/{id}/links` replaces the whole link set, so read and
merge first:

```bash
EXISTING=$(curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/links")
LINK_BODY=$(printf '%s\n' "$EXISTING" | jq -ce --argjson id "$TARGET_ID" \
  'if .ok == true and (.raw | type) == "array"
   then {linkedMonitorIds:([.raw[].linkedMonitorId] + [$id] | unique)}
   else error("Cannot read existing links") end')
curl -fsS -X PUT "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/links" \
  -H "Authorization: Bearer $FLATLINE_TOKEN" -H "Content-Type: application/json" \
  -d "$LINK_BODY"
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/links"
```

`SERVER_ID` is the push monitor named in this link when the credential is a
push-agent token, or the discovered host monitor otherwise. Abort if the
read failed; never PUT an empty fallback body. Verify `raw` and `resolved`:
a 200 alone does not prove every target was accepted.

---

## 7. Wait, then verify

After the agent is running and the links are saved, **wait two minutes**
before judging the result: the agent pushes on its interval, website checks
run on `interval`, and the engine needs a beat to settle.

Then check:

```bash
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" "{{ORIGIN}}/api/v1/health"
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID"
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/metrics/latest"
curl -fsS -H "Authorization: Bearer $FLATLINE_TOKEN" \
  "{{ORIGIN}}/api/v1/monitors/$SERVER_ID/heartbeats?limit=20"
```

Expected:

1. The push monitor is UP with telemetry no older than a few sample
   intervals, from the intended machine.
2. Every new website monitor is UP for the agreed URL/status policy, or
   PENDING with retries that have not exhausted; a first check can take one
   interval.
3. The link response resolves to the intended website/group IDs.
4. `ignoredFields` is empty or understood.
5. `health.total` grew by the number created and `down` contains only
   expected entries.

Status codes: `0` DOWN, `1` UP, `2` PENDING, `3` MAINTENANCE. Pending can
mean "no result yet" or "retrying a failure": read heartbeats and messages
before treating it as installation delay.

### If something is wrong

| Symptom                                                                           | Likely cause and fix                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agent_token_on_operator_api`                                                     | You used the link's agent token on `/api/v1`. Request an operator token (§3).                                                      |
| `operator_token_on_agent_api`                                                     | You used the operator token on `/api/push/...` or the wrong download URL. Use the monitor's push token there.                      |
| `push_agent_token_on_backup_agent_api` / `backup_agent_token_on_metric_agent_api` | The two agent families are not interchangeable. Use the credential from the matching monitor/registration.                         |
| `agent_monitor_inactive`                                                          | The push monitor is paused. Resume it with an operator token, then retry.                                                          |
| `unauthorized`                                                                    | Missing/invalid token, wrong family, paused monitor, or revoked key. Read `hint`; do not loop.                                     |
| `unavailable` / `rate_limited`                                                    | Store hiccup or too many failed imported-key checks. Retry after `retryAfterSeconds`; it is not a wrong token.                     |
| Agent push 404                                                                    | Monitor deleted, paused, or the host holds a token for a different monitor. Compare config privately.                              |
| No telemetry                                                                      | `sudo superboard check`, `systemctl status superboard`, `journalctl -u superboard -n 50`; confirm `server_url` and outbound HTTPS. |
| Website DOWN while host UP                                                        | Application, URL, TLS or reachability from Flatline; host UP is not website UP.                                                    |
| Website check PENDING                                                             | Wait one interval, then read heartbeats; a failing retry is pending, not success.                                                  |
| Checksum mismatch                                                                 | Retry the download; if persistent, report a server/proxy mismatch. Never bypass verification.                                      |
| Agent updated but old version runs                                                | Check the service/process on the host; non-systemd installs need a manual restart.                                                 |
| Config kept an old token                                                          | The installer preserves config by design. Resolve ownership; do not force a token swap on a shared host.                           |

---

## 8. Report

Report, in this order:

- Project/environment and the target host(s), with the monitor IDs used.
- Whether the agent was installed, reused or updated, and its version.
- Websites created vs reused, their URLs, intervals and group path.
- The notification destination(s) chosen and which monitors were assigned
  (state that delivery was requested, not independently observed).
- The link PUT result (`raw`/`resolved`) for the host card.
- Verification results from §7, including anything still PENDING.
- Failed checks, unsupported requirements and missing access.

Never include tokens, config contents or private URLs in the report. If
installation was handed to a human, label the onboarding "awaiting host
installation" and do not report it as verified.

---

## 9. API reference

Operator API success responses are `{"ok":true,...}`. Errors are
`{"ok":false,"error":"code","code":"code","message":"...","hint":"...",
"details":{...}}`; `hint` states the fix, `details` carries machine-readable
context. `retryAfterSeconds` and `Retry-After` appear on 429/503.

### Create fields (writable)

| Fields                                                                        | Meaning                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `name`, `description`, `active`                                               | Display name, free text, pause switch                                                |
| `type`                                                                        | `http`, `https`, `push`, `ping`, `group`; create only, immutable                     |
| `interval`                                                                    | Seconds, 20–86400                                                                    |
| `retryInterval`, `maxretries`, `timeout`, `resendInterval`                    | Scheduling; timeout defaults to 80% of interval                                      |
| `parent`, `weight`                                                            | Group ID (or null), ordering weight (higher first)                                   |
| `url`, `method`, `accepted_statuscodes`, `ignoreTls`, `maxredirects`          | HTTP checks                                                                          |
| `hostname`, `packetSize`, `pingCount`, `pingNumeric`, `pingPerRequestTimeout` | Ping checks                                                                          |
| `pushToken`                                                                   | Push credential; generated automatically, prefix `flatline_agent_push_`, re-readable |
| `metricCpuThreshold`, `metricRamThreshold`, `metricDiskThreshold`             | Telemetry alert percentages; 60 s sustained, 5-point recovery                        |
| `notificationIDList`                                                          | Notification assignments; array replaces, object merges                              |

Unknown fields are ignored and returned in `ignoredFields`.

### Host push monitor

A push monitor is created with `type:"push"`. The response carries
`monitor.pushToken` and `pushTokenKind:"push_agent"`. Its token is what the
host agent and this runbook's link use. For the fleet's scheduling
convention use `interval:20`, `maxretries:2`, `retryInterval:180`: about six
minutes of silence before DOWN and a notification.

### Useful endpoints (operator bearer token)

- `GET /api/v1/auth/me` — token kind, capabilities.
- `GET /api/v1/monitors?perPage=200&page=1` — inventory, paginated.
- `GET /api/v1/notifications` — alert destinations.
- `GET /api/v1/monitor-types` — supported types and writable fields.
- `GET /api/v1/health` — fleet summary.
- `GET /api/v1/monitors/{id}` — one monitor.
- `GET /api/v1/monitors/{id}/heartbeats?limit=100` — recent checks/messages.
- `GET /api/v1/monitors/metrics/latest?ids=1,2` — batched latest telemetry.
- `GET /api/v1/monitors/{id}/links` — website links (`raw`, `resolved`).
- `GET /api/v1/openapi.json` — public OpenAPI document.

PATCH only the fields that change. Deletes, uninstalls and removing existing
associations need explicit human confirmation. Deleting a group without
`?deleteChildren=true` preserves its children; the flag deletes the subtree.

### Downloads (operator or push-agent token)

- Installer: `{{ORIGIN}}/agent/install.sh?token={{TOKEN}}`
- Version/builds/hashes: `{{ORIGIN}}/agent/version?token={{TOKEN}}`
- Checksums: `{{ORIGIN}}/agent/sha256sums?token={{TOKEN}}`
- Linux amd64: `{{ORIGIN}}/agent/superboard-linux-amd64?token={{TOKEN}}`
- Linux arm64: `{{ORIGIN}}/agent/superboard-linux-arm64?token={{TOKEN}}`

Only builds shipped by the deployed instance are available. The runbook is
embedded in the backend binary: publishing an updated runbook requires
rebuilding and deploying the backend.
