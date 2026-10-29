# Flatline HTTP API

The Flatline backend (`backend-rs/`) serves the dashboard and the API from one
process and one origin, so a browser, an LLM tool and the Go agent in
`superboard/` all use the same base URL. See [architecture](architecture.md) for
how the pieces fit, [agent](agent.md) for the agent side of the push contract,
and [superboard](superboard.md), [deployment](deployment.md) and
[operations](operations.md) for the surrounding system.

## Base URL and same-origin model

- The backend binds `0.0.0.0:3001` by default (`UPTIME_KUMA_HOST`, `PORT`).
  Every path below is absolute to that origin; there is no separate API host.
- API paths are `/api/...`, `/add-push-server.md`, `/llms.txt`, `/agent/...`
  and `/api/v1/openapi.json`. The built dashboard is served by the same
  process: unknown non-API `GET`/`HEAD` paths get the SPA shell, while API paths
  always get a JSON `404`.
- Absolute URLs inside the provisioning runbook, the installer and
  `/agent/version` use `FLATLINE_PUBLIC_URL` when set, otherwise the request's
  `Host` / `X-Forwarded-*` headers. Set it behind a proxy. The OpenAPI document
  at `/api/v1/openapi.json` is the machine-readable companion to this page.

## Authentication

Credentials come in three families, told apart by prefix:

| Prefix                   | Kind                | Accepted by                                      |
| ------------------------ | ------------------- | ------------------------------------------------ |
| `flatline_op_`           | Operator            | GUI sign-in and every `/api/v1` route            |
| `flatline_agent_push_`   | Host (metric) agent | `/api/push/{pushToken}`, `/agent/*`, the runbook |
| `flatline_agent_backup_` | Backup agent        | `/api/backup/v1` only                            |

Legacy `flatline_<hex>` tokens minted before the split are still accepted;
they are resolved by the store that holds them (operator table, monitor push
token, backup-agent hash). New tokens are always minted with a family prefix.

**Operator bearer token.** Every `/api/v1` route except `auth/setup`, `auth/session`,
`auth/login` and `openapi.json` requires
`Authorization: Bearer flatline_op_<hex>`. Tokens come from the dashboard's
**Agents** panel, backed by `POST /api/v1/api-keys`, or from the bootstrapped
admin token printed on first boot and written to `data/initial-token.txt`
(`0600`). `POST /api/v1/auth/login` accepts the token in the `password` field and echoes
it back together with `tokenKind:"operator"`, `GET /api/v1/auth/me` reports the
credential kind and capabilities, and `GET /api/v1/api-keys` lists operator
tokens only. The `username` field is ignored — these routes exist so the
dashboard's sign-in flow works unchanged.

**Browser session cookie.** The web app signs a browser in with
`POST /api/v1/auth/session`: body `{"email": ..., "password": ...}` signs a
member in (see [Accounts](#accounts)) and answers
`{ok:true, principal:"account", mustChangePassword}`; body
`{"token": "flatline_op_..."}` signs in with an operator token (the wall TV,
recovery) and answers `{ok:true, principal:"token"}`. A wrong email and a wrong
password answer the same `401 unauthorized`, so the form does not reveal which
emails exist; a token failure answers as `auth/login` does. On success the
answer sets the `fl_session` cookie (`HttpOnly; SameSite=Lax; Path=/;
Max-Age=34560000`, plus `Secure` when the request arrived over HTTPS) holding a
random session id (`fls_...`), never the token or password; the server stores
only its SHA-256. A session ends when:

- it is signed out (`DELETE /api/v1/auth/session`, which works with a missing
  or already-ended session too);
- it goes unused for 30 days (an account) or 400 days (a token);
- its account is removed;
- its token is disabled, expires or is deleted.

Every `/api/v1` route (the SSE stream included) accepts the cookie when no
`Authorization` header is sent, and `GET /api/v1/auth/me` reports the
`principal`: `account: {id, email, name, mustChangePassword}` or
`token: {id, name}` (a bearer token reports its token too). The live stream
rechecks its credential every 15 seconds and sends `{"type":"unauthorized"}`
once the session has ended. A cookie-authenticated request other than GET, HEAD
or OPTIONS must also send `X-Flatline-CSRF: 1`, or it is refused with
`403 csrf_required`; bearer requests need no such header.

An agent token used for sign-in or on `/api/v1` is not a generic 401: the API
answers `401` with `error:"agent_token_on_operator_api"`, the presented
`tokenKind`, `expectedPrefix:"flatline_op_"` and a `hint`. Operator tokens on
agent endpoints are rejected symmetrically with
`operator_token_on_agent_api`.

**There is exactly one scope: full.** Every token is a full-permission operator
credential — the admin token and keys minted from the Agents panel or
`POST /api/v1/api-keys` are identical in authority, and so is a member account. There is no read-only key
and no way to restrict a token. `GET /api/v1/api-keys` reports
`availableScopes: ["full"]` and each key reports `scopes: ["full"]`. Tokens are
stored as SHA-256 hashes and plaintext is shown once at mint time; keys imported
from the previous deployment's bcrypt hashes keep verifying.

**Tokens remember their maker.** A key minted by a member's session, or the
token a screen gets when a member approves its QR sign-in, records that member;
`GET /api/v1/api-keys` reports it as `maker: {id, name, removed}`. Keys minted
with a bearer token or a token session, and every key from before accounts,
report `maker: null`. Removing a member can disable the keys they made in the
same step (`DELETE /api/v1/users/{id}` with `revokeTokenIds`); a kept key keeps
working and reports `removed: true` with the member's last name.

Imported (bcrypt) keys are the slow path, so it is fenced: a `flatline_`,
`flatline_op_` or `flatline_agent_` token is only ever checked by SHA-256, a verified imported key is cached for 10 minutes
(its row is still read on every request, so revoking or expiring it applies at
once), a token that failed is rejected without bcrypt for a minute, and more
than 30 failed bcrypt checks a minute instance-wide answer `429` for further
unknown tokens outside those prefixes until the minute is up. `last_used_at` is updated
at most once a minute per token.

**Push token (host agents).** A push token is a separate credential of the
agent family, created automatically with each `push` monitor
(`pushToken`, `pushTokenKind:"push_agent"` and `pushTokenPrefix` in the monitor
JSON, also returned by `POST /api/v1/monitors`). It authenticates the agent's
posts at `POST /api/push/{pushToken}` and acts as the fleet whitelist for
`/agent/*`: only a host holding an active monitor's push token can download an
agent update. `/agent/*`, `/add-push-server.md` and `/llms.txt` accept either
an operator token or a push-agent token, via `Authorization` or `?token=`.
Backup-agent tokens are not accepted there: metric and backup agents stay
separate. A paused monitor (`active: false`) has an unusable push token and is
excluded; the provisioning surfaces answer `agent_monitor_inactive` and name
the monitor.

## Response envelope and status codes

Success responses carry `"ok": true` plus endpoint data, for example
`{"ok":true,"monitor":{...}}` or
`{"ok":true,"monitors":[...],"count":n,"pagination":{...}}`. Failures use
`{"ok":false,"error":"code","code":"code","message":"...","hint":"...","details":{...}}`.
`error` and `code` carry the same stable machine string; `message` is human
text; `hint` states the fix (it names the required credential family on auth
errors); `details` carries structured context. Auth errors may also carry
`tokenKind`, `expectedTokenKind`, `expectedPrefix`/`expectedPrefixes` and
`nextActions`; 429/503 carry `retryAfterSeconds`/`Retry-After`. Examples:
`bad_request`, `not_found`, `unauthorized`, `agent_token_on_operator_api`,
`operator_token_on_agent_api`, `backup_agent_token_on_metric_agent_api`,
`push_agent_token_on_backup_agent_api`, `agent_monitor_inactive`,
`server_error`, `stream_limit`, `unavailable`, `rate_limited`, `timeout`,
`busy`. Exceptions: the push endpoint uses
`{"ok":false,"msg":"..."}`; badges answer `{"status":"fail","msg":...}` for a
bad id or duration; a gated status page answers `401` with `error:"password_required"` and a
missing page is plain-text `404`.

| Code      | Meaning                                                                                                              | Where it occurs                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 200 / 201 | Success / Created                                                                                                    | Reads and updates; `POST` monitors and API keys                      |
| 400       | Validation failure; on push, "metrics dropped"; invalid badge duration                                               | Bad type/`name`/range, bad `hours`/`ids`, invalid metrics            |
| 401       | Missing/invalid/inactive/expired token; agent token on operator API; operator token on agent API; locked status page | Any `/api/v1` route; push/agent routes; gated status-page reads      |
| 403       | Invalid badge id                                                                                                     | `/api/badge/{id}/...` with a non-numeric or non-positive id          |
| 404       | Unknown resource, unknown/paused push monitor, no metrics, out-of-range ping                                         | `.../{id}`, `POST /api/push/{pushToken}`                             |
| 404       | Unpublished status page (without an operator token)                                                                  | Every `/api/status-page/...` read and the unlock route               |
| 409       | Not emitted today                                                                                                    | A duplicate `pushToken` hits the unique index but is reported as 500 |
| 413       | Body over the 256 KB limit                                                                                           | `POST /api/push/{pushToken}`                                         |
| 429       | Too many live SSE connections                                                                                        | `GET /api/v1/events` (`stream_limit`)                                |
| 429       | Too many failed imported-key checks; public reads saturated (`rate_limited`)                                         | Token-checked routes; status-page and badge routes (`Retry-After`)   |
| 500       | Storage failure                                                                                                      | Any handler except the push endpoint                                 |
| 503       | Token store unreadable (`unavailable`); budget exceeded (`timeout`, `busy`)                                          | Token-checked routes; any timed route (`Retry-After`)                |
| 503       | Storage failure on push (transient), with `Retry-After`                                                              | `POST /api/push/{pushToken}`                                         |
| 503       | `/healthz`: database or check engine unhealthy (`reason`)                                                            | `GET /healthz`                                                       |

A `503 unavailable` says nothing about the token: clients must retry rather than
sign out. Only a `401` means the token is wrong.

**Request budgets.** API, provisioning and push requests must produce a response
within 30 s and share an in-flight cap of 256 (`503 timeout` / `503 busy`).
Status-page and badge reads have a 15 s budget and their own cap of 16 in-flight
requests (a request waits up to 2 s for a slot, then `429`). The cap is
instance-wide, not per IP: behind the tunnel every request has the same source.
The SSE stream and agent binary downloads have no timeout.

## Endpoint reference

### Auth

| Method | Path                          | Purpose                                                                                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/auth/setup`          | Public; `setupNeeded` is true while no account exists                                                                                |
| POST   | `/api/v1/auth/setup`          | Public; body `{token, email, name, password}`; creates the first account (needs an operator token; `409 setup_done` once any exists) |
| POST   | `/api/v1/auth/password`       | Body `{currentPassword, newPassword}`; a member changes their own password                                                           |
| POST   | `/api/v1/auth/login`          | Public; token in `password`, echoed back                                                                                             |
| POST   | `/api/v1/auth/session`        | Public; body `{email, password}` or `{token}`; sets the session cookie                                                               |
| DELETE | `/api/v1/auth/session`        | Public; ends the session and clears the cookie                                                                                       |
| GET    | `/api/v1/auth/me`             | Who is signed in: `principal` `account` or `token`                                                                                   |
| POST   | `/api/v1/auth/device/start`   | Public; a screen asks to sign in with a QR code. Returns `code`, `pollSecret`, `expiresIn`, `publicUrl`                              |
| POST   | `/api/v1/auth/device/poll`    | Public; body `{code, pollSecret}`. `pending`, `denied`, `expired`, or `approved` with a new never-expiring operator `token`          |
| POST   | `/api/v1/auth/device/lookup`  | Describe a waiting screen (user agent, age, suggested name)                                                                          |
| POST   | `/api/v1/auth/device/approve` | Body `{code, name}`; the screen gets its own operator token                                                                          |
| POST   | `/api/v1/auth/device/deny`    | Body `{code}`                                                                                                                        |

Device codes travel in JSON bodies, never in paths. The QR code encodes
`<base>/device#<code>` only; the poll secret never leaves the waiting screen.
At most 64 requests wait at once per instance (429 `busy` beyond that), each
for 5 minutes.

### Accounts

People sign in to the web app with their own email and password. Every account
has full permission, the same as an operator token: accounts give each person
their own credentials, not different rights. Anyone signed in, and any operator
bearer token, may manage them.

| Method | Path                                | Purpose                                                                             |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/v1/users`                     | List members by name, each with `tokenCount`                                        |
| POST   | `/api/v1/users`                     | Body `{email, name, password}`; adds a member with a starting password              |
| GET    | `/api/v1/users/{id}`                | One member and the operator tokens they minted (`tokens: [{id, name, active}]`)     |
| PATCH  | `/api/v1/users/{id}`                | Body `{name?, email?}`                                                              |
| POST   | `/api/v1/users/{id}/reset-password` | Body `{password}`; a new starting password                                          |
| DELETE | `/api/v1/users/{id}`                | Body `{revokeTokenIds?}`; removes a member and disables the listed tokens they made |

A member is `{id, email, name, mustChangePassword, startingPasswordExpired,
createdAt}`; no response carries a password or its hash. Emails are stored as
entered and unique ignoring case (`409 email_taken`); names are 1 to 100
characters. Passwords need at least 10 characters and nothing else
(`400 weak_password`), and are stored as bcrypt hashes (cost 12, or
`FLATLINE_PASSWORD_COST`). A password set by someone else, on add or reset, is a
starting password: `mustChangePassword` is true until its owner chooses their
own, and one left unchanged for 7 days expires (`startingPasswordExpired`):
sign-in then answers `401 starting_password_expired` ("Ask someone to reset your
password."), and only after the password matched.

- **Must change.** A member signed in with a starting password can reach only
  `GET /api/v1/auth/me`, `POST /api/v1/auth/password` and sign-out; everything
  else, the live stream included, answers `403 password_change_required`.
- **Changing your password** (`POST /api/v1/auth/password`) needs the current
  one (`400 wrong_password` otherwise), clears "must change" and signs out the
  member's other browsers. A bearer token or token session has no password to
  change (`400 not_an_account`).
- **Resetting** a member's password gives them a new starting password and signs
  them out everywhere at once.
- **Removing** a member signs them out everywhere at once and, for each token
  they made, either disables it (listed in `revokeTokenIds`) or keeps it. Nobody
  removes their own account (`409 cannot_remove_self`); removing the last
  account is allowed, since token sign-in always remains.
- **Sign-in limits.** Failed email/password sign-ins are limited to 5 per email
  and 20 per client address in 15 minutes; past that, even the right password
  answers `429 rate_limited` with `retryAfterSeconds` and a `Retry-After`
  header. A successful sign-in clears the email's count. The client address is
  Cloudflare's `CF-Connecting-IP`, else the first `X-Forwarded-For` hop; the
  proxy in front must strip both from anyone but Cloudflare.
- **The first account.** While no account exists, `GET /api/v1/auth/setup`
  answers `setupNeeded: true` and `POST /api/v1/auth/setup` with any valid
  operator token (for example the first-boot one in `data/initial-token.txt`)
  creates an account and signs it in. Once one exists it answers
  `409 setup_done`; add people from Members instead. An existing install gets no
  accounts on upgrade: sign in with a token once and add yourself.

### Monitors, heartbeats and links

| Method | Path                                                     | Purpose                                          |
| ------ | -------------------------------------------------------- | ------------------------------------------------ |
| GET    | `/api/v1/monitor-types`                                  | Supported types and `writableFields`             |
| GET    | `/api/v1/monitors`                                       | List; `page`, `perPage`, `status`, `active`, `q` |
| POST   | `/api/v1/monitors`                                       | Create a monitor                                 |
| GET    | `/api/v1/monitors/{id}`                                  | One monitor with live status and uptime          |
| PATCH  | `/api/v1/monitors/{id}`                                  | Partial update (type is immutable)               |
| DELETE | `/api/v1/monitors/{id}?deleteChildren=true`              | Delete, optionally a group subtree               |
| GET    | `/api/v1/monitors/{id}/heartbeats?limit=`                | Recent heartbeats, newest first                  |
| POST   | `/api/v1/monitors/{id}/push-failures/clear`              | Acknowledge `failedPushes`                       |
| POST   | `/api/v1/monitors/{id}/agent-warnings/clear`             | Acknowledge all agent warning counters           |
| POST   | `/api/v1/monitors/{id}/mute`                             | Mute a known outage (400 when nothing is down)   |
| DELETE | `/api/v1/monitors/{id}/mute`                             | Unmute it and every mute covering it             |
| GET    | `/api/v1/monitors/links?ids=1,2,3`                       | Bulk links for many monitors (max 200)           |
| GET    | `/api/v1/monitors/heartbeat-strips?ids=&hours=&buckets=` | Bucketed status strips (max 200 ids)             |
| GET    | `/api/v1/monitors/{id}/links`                            | Raw and resolved links                           |
| PUT    | `/api/v1/monitors/{id}/links`                            | Replace; body `{"linkedMonitorIds":[1,2]}`       |
| DELETE | `/api/v1/monitors/{id}/links`                            | Clear all links                                  |

#### Mutes

Muting acknowledges a known outage. The server snapshots what is down on the
monitor (itself and the websites linked to it) and the disks its latest sample
reports failing SMART or over the disk-full level. The board then shows it dark
red and Telegram stops repeating it. Every monitor object carries `mute` (its
own mute as a subject, or `null`) and `mutedBy` (the subjects whose mute covers
it; a down group is covered when every down monitor inside it is). A mute ends
by itself when something new breaks on the monitor or when everything in the
snapshot has recovered. What it silences is described in
[superboard.md](superboard.md#muting-a-known-outage).

#### Heartbeat strips

`GET /api/v1/monitors/heartbeat-strips?ids=1,2,3&hours=24&buckets=48` returns one compact status strip per monitor, for dashboards.
`ids` is optional (omitted = the first 200 monitors by id; more than 200 ids or a malformed id is a 400), `hours` is 1-168 (default 24), `buckets` is 1-120 (default 48).
`hours * 3600 / buckets` must be a whole number of seconds and at least 60, otherwise 400.

```json
{
  "ok": true,
  "hours": 24,
  "buckets": 48,
  "bucketSeconds": 1800,
  "start": "2026-10-21T10:30:00.000Z",
  "strips": { "7": [[1, 90, 0], null, [0, 90, 61]] }
}
```

Each strip has exactly `buckets` entries, oldest first. An entry is `[worstStatus, beats, failedBeats]` or `null` when the bucket has no heartbeats.
Status codes are the heartbeat codes (0 down, 1 up, 2 pending, 3 maintenance); the worst status wins by severity down > pending > maintenance > up.
`beats` counts heartbeat rows in the bucket and `failedBeats` those with status 0. Unknown ids are absent from `strips`; groups are included.

**Bucket alignment.** Buckets are aligned to multiples of `bucketSeconds` since the Unix epoch: the bucket index of a time is `floor(epochSeconds / bucketSeconds)`.
The last entry is the bucket containing the server's "now", and `start` is the UTC start of the first one, so a client can place a live beat at
`floor((beatEpochSeconds - startEpochSeconds) / bucketSeconds)` without asking again. Results are cached on the server for about 10 seconds, never across a bucket boundary.

### Metrics

| Method | Path                                           | Purpose                                           |
| ------ | ---------------------------------------------- | ------------------------------------------------- |
| GET    | `/api/v1/monitors/metrics/latest?ids=4,5,6`    | Bulk latest (max 200; missing entries are `null`) |
| GET    | `/api/v1/monitors/{id}/metrics/latest`         | Latest sample                                     |
| GET    | `/api/v1/monitors/{id}/metrics/summary?hours=` | Windowed summary and chart series                 |
| GET    | `/api/v1/monitors/{id}/metrics?hours=`         | Raw snapshots, newest first                       |

### Notifications and API keys

| Method         | Path                         | Purpose                                                  |
| -------------- | ---------------------------- | -------------------------------------------------------- |
| GET            | `/api/v1/notifications`      | List; credential fields are never echoed                 |
| POST           | `/api/v1/notifications`      | Create (`name`, `type`, `active`, `isDefault`, `config`) |
| PATCH / DELETE | `/api/v1/notifications/{id}` | Update or delete                                         |
| GET            | `/api/v1/api-keys`           | List keys (metadata only, with each key's `maker`)       |
| POST           | `/api/v1/api-keys`           | Mint a full-permission key; `token` returned once        |
| PATCH          | `/api/v1/api-keys/{id}`      | Enable/disable (`{"active":false}`)                      |
| DELETE         | `/api/v1/api-keys/{id}`      | Revoke                                                   |

### Status pages (public reads, password-gated)

Pages are provisioned by the importer; this backend exposes reads, not page CRUD.

| Method | Path                                               | Purpose                                     |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/status-page/resolve-host?host=`              | Resolve a hostname to a page slug           |
| GET    | `/api/status-page/{slug}`                          | Page data (name, groups, monitors)          |
| GET    | `/api/status-page/heartbeat/{slug}`                | Public heartbeat bars                       |
| GET    | `/api/status-page/{slug}/incident-history?cursor=` | Paged incident history                      |
| GET    | `/api/status-page/{slug}/manifest.json`            | PWA manifest                                |
| GET    | `/api/status-page/{slug}/badge`                    | Aggregate page badge (SVG)                  |
| POST   | `/api/v1/status-pages/unlock/{slug}`               | Submit the password; sets the unlock cookie |

Unpublished pages answer `404` on every route above (as if the slug did not
exist) unless the request carries a valid operator bearer token, and
`resolve-host` never maps to them. `resolve-host` answers `503 unavailable` when the
lookup fails; `slug: null` always means the host is unmapped. Gated reads answer `401` until unlocked.
Responses are cached for 10 s; the published flag and password are checked on
every request. The unlock route accepts JSON
(`{"password":"..."}`) or a form body and, on success, redirects with a signed
cookie.

### Badges (public SVG)

| Method | Path                                                           | Purpose                           |
| ------ | -------------------------------------------------------------- | --------------------------------- |
| GET    | `/api/badge/{id}/status`                                       | Latest status                     |
| GET    | `/api/badge/{id}/uptime` / `.../uptime/{duration}`             | Uptime percentage                 |
| GET    | `/api/badge/{id}/ping` / `.../ping/{duration}`                 | Average ping                      |
| GET    | `/api/badge/{id}/avg-response` / `.../avg-response/{duration}` | Average response (hours, max 720) |
| GET    | `/api/badge/{id}/response`                                     | Latest heartbeat ping             |

Badges honour `label`, `prefix`/`suffix`, `color` and `style`; only monitors on
a public group of a published status page get real values, and everything else
is grey `N/A`. A `{duration}` is a positive number with an optional unit (`m`,
`h`, `d`, `w`, `M`, `y`; hours by default); an unparseable or unrepresentable one
answers `400`, and any window is clamped to the heartbeat retention (365 days
when retention is off). Values are cached for 10 s.

### Provisioning and agent downloads

Outside `/api/v1`, authenticated by an operator token or a push-agent token.
Backup-agent tokens are accepted only under `/api/backup/v1`.

| Method | Path                  | Purpose                                          |
| ------ | --------------------- | ------------------------------------------------ |
| GET    | `/add-push-server.md` | Runbook, rendered with origin, token and version |
| GET    | `/llms.txt`           | Pointer file for LLM crawlers                    |
| GET    | `/agent/install.sh`   | Pre-credentialed installer/updater               |
| GET    | `/agent/version`      | Version, size, SHA-256 and URL per platform      |
| GET    | `/agent/sha256sums`   | Checksums for the shipped builds                 |
| GET    | `/agent/{file}`       | One `superboard-<os>-<arch>` binary              |
| GET    | `/robots.txt`         | Public; advisory `Disallow: /`                   |

### Backup-agent self-update

Under `/api/backup/v1`, authenticated by a backup-agent token only (operator
and push tokens are refused). The backup agent updates on its own version line,
separate from the telemetry agent above; see [backup-agent](backup-agent.md).

| Method | Path                            | Purpose                                                                                                  |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| POST   | `/api/backup/v1/checkin`        | Report `{version, platform, updateStatus}`; answers the shipped `release` (version, per-platform sha256) |
| GET    | `/api/backup/v1/release/{file}` | One `flatline-backup-<os>-<arch>` build; anything else is 404                                            |

Run starts may also carry `agentVersion`. The latest reported version, its
time and the last update outcome appear on every backup agent as
`reportedVersion`, `versionReportedAt` and `updateStatus`.

### Health, live events and the agent push

| Method    | Path                    | Purpose                                           |
| --------- | ----------------------- | ------------------------------------------------- |
| GET       | `/healthz`              | Liveness, no token (see below)                    |
| GET       | `/api/v1/health`        | Totals: up/down/pending/paused and `downMonitors` |
| GET       | `/api/v1/events`        | SSE stream; `?metrics=0` drops metrics events     |
| GET, POST | `/api/push/{pushToken}` | Agent heartbeat plus optional metrics             |

`GET /healthz` needs no token and is cheap (one `SELECT 1`, no table reads). It
answers `200` with `{"status":"ok","reason":null,"db":{...},"engine":{...}}`
only when the database answers within 2 s and the check engine is running with
a watchdog tick younger than 30 s; otherwise `503` with `"status":"unavailable"`
and a `reason` (`database error`, `database probe timed out`, `engine not
running`, `engine watchdog stalled`). `engine` reports `running`, `tickAgeMs`,
`loops` and `stalled`. `/api/v1/health` answers `503`
(`{"ok":false,"error":"unavailable"}`) when its query fails, instead of an
empty fleet reported as up. SSE streams end when the server shuts down; clients
reconnect as they do after the 15-minute lifetime.

## The push contract

`POST /api/push/{pushToken}` (GET is also accepted for legacy agents) selects an
active monitor by token in the path; a missing or paused monitor answers `404`.

- Query: `msg` (default `OK`), `ping` (finite milliseconds; out of range answers
  `404`), `status` (`up` by default, anything else is `down`).
- Body (optional JSON): a `metrics` field holding any non-null JSON sample,
  limited to 64 KB; the whole body is limited to 256 KB (`413` beyond that).
- A legacy POST/GET records a heartbeat, then stores metrics. If the metrics are
  rejected the answer is `400` with "Heartbeat recorded, metrics dropped: ..." —
  the heartbeat stands. A non-empty body that is not valid JSON is rejected the
  same way (it used to be accepted with `{"ok":true}` and its metrics silently
  lost); an empty or whitespace-only body is a plain heartbeat.
- `?telemetry=1` (POST with metrics) takes a fast path: while the previous beat
  is UP and the heartbeat spacing (one third of the interval, clamped to 1–30s)
  has not elapsed, the sample is stored **without** a heartbeat row and the
  answer is `{"ok":true}`. A metrics failure here answers `400` ("Metrics
  dropped: ...") because no heartbeat was written.

Push status codes are a contract with the agent, which treats them differently:

| Code | Meaning                                                    | Sender should                                 |
| ---- | ---------------------------------------------------------- | --------------------------------------------- |
| 200  | Stored                                                     | Move on                                       |
| 400  | Validation failure only: invalid metrics, body is not JSON | Not retry; the same payload fails identically |
| 404  | Unknown or paused monitor, out-of-range ping               | Fix the token or monitor; keep the backlog    |
| 413  | Body over 256 KB                                           | Not retry                                     |
| 503  | Storage or database failure (lock timeout, disk full, ...) | Keep the sample and retry after `Retry-After` |

A `503` carries `Retry-After: <seconds>` (5–30, jittered so a fleet does not
retry in lockstep) and `{"ok":false,"msg":...}`. It is answered whether the
heartbeat, the metrics or the token lookup failed; when only the metrics write
failed the message says the heartbeat was recorded. A storage failure is never
a `400` or a `404`: those would make the agent drop the sample or treat a
database hiccup as a bad token.

## Monitor types and fields

`GET /api/v1/monitor-types` is the source of truth.

| Type    | Required beyond `name`/`type` | Notes                                      |
| ------- | ----------------------------- | ------------------------------------------ |
| `http`  | `url`                         | HTTP probe                                 |
| `https` | `url`                         | HTTPS probe                                |
| `push`  | —                             | Gets a `pushToken` at creation             |
| `ping`  | `hostname`                    | ICMP probe                                 |
| `group` | —                             | Container; children set `parent` to its id |

Create requires `name` and `type`; `PATCH` rejects a `type` change. `status` is
`1` up, `0` down, `2` pending, `3` maintenance; a monitor with no heartbeat
reports `2`. The JSON also carries `interval`, `weight`, `parent`,
`uptime24h`/`uptime7d`/`uptime30d` (ratios `0..1` or `null`), the metric
thresholds, and the acknowledged agent counters (`pushFailuresAck`,
`samplesDroppedAck`, `collectorErrorsAck`). `tags` is always `[]`.

Writable fields are `active`, `description`, `interval`, `retryInterval`,
`maxretries`, `resendInterval`, `timeout`, `upsideDown`, `parent`, `weight`,
`provider`, `url`, `method`, `accepted_statuscodes`, `ignoreTls`, `maxredirects`,
`pushToken`, `hostname`, `packetSize`, `pingCount`, `pingNumeric`,
`pingPerRequestTimeout`, `metricCpuThreshold`, `metricRamThreshold` and
`metricDiskThreshold`. `notificationIDList` is accepted and applied. Anything
else — `tags`, `type` on update, unknown upstream fields — is reported back in
the `ignoredFields` array on create and update instead of failing, so a form may
post its whole payload. `interval` must be at least 20 and a bad value is a
`400`, never a silent clamp.

## Pagination, filters and retention

- **Monitor list** — `page` (default 1, min 1) and `perPage` (default 50, max
  200). `status` filters after the latest heartbeat is resolved (`up`, `down`,
  `pending`, `maintenance`); `active` is `true`/`false`; `q` matches `name` or
  `url` (first 100 chars). The response carries a `pagination` object with
  `page`, `perPage`, `total`, `totalPages` and `hasMore`.
- **Heartbeats** — `limit` defaults to 100 and is capped at 1000; rows are newest
  first by `time` (then `id`); `total` is the true stored count.
- **Bulk latest metrics** — `ids` is comma-separated, at most 200.
- **Metrics summary** — `hours` defaults to 1 and may reach 17520 (two years).
  Windows up to 168h read raw ~30s snapshots; longer windows read hourly
  rollups. Percentiles are nearest-rank; `capped: true` means the newest
  50,000-row safety limit truncated the window.
- **Raw metrics** — `hours` defaults to 24, is capped at 168, and returns at most
  1000 rows newest-first with a `capped` flag.

Retention: heartbeats are kept 90 days by default
(`FLATLINE_HEARTBEAT_RETENTION_DAYS`; `0` keeps them forever). Raw metric
snapshots are kept 30 days; the hourly rollups behind long summary windows are
kept 730 days. Pruning runs as a background job, so `capped: true` and empty
windows are normal at the edges.

## curl examples

```sh
# Create an HTTP monitor.
curl -sS -X POST https://uptime.example/api/v1/monitors \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Web","type":"https","url":"https://example.com","interval":60}'

# Create a push monitor and read the token the agent will use.
curl -sS -X POST https://uptime.example/api/v1/monitors \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"edge-01","type":"push","interval":30}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["monitor"]["pushToken"])'

# Read the latest metrics for a monitor.
curl -sS https://uptime.example/api/v1/monitors/4/metrics/latest \
  -H "Authorization: Bearer $TOKEN"

# Clear a monitor's acknowledged agent warnings.
curl -sS -X POST https://uptime.example/api/v1/monitors/4/agent-warnings/clear \
  -H "Authorization: Bearer $TOKEN"

# Fetch the provisioning runbook (query token works for shell and LLM tools).
curl -sS "https://uptime.example/add-push-server.md?token=$TOKEN"
```
