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

**Operator bearer token.** Every `/api/v1` route except `auth/setup`,
`auth/login` and `openapi.json` requires
`Authorization: Bearer flatline_<hex>`. Tokens come from the dashboard's
**Agents** panel, backed by `POST /api/v1/api-keys`, or from the bootstrapped
admin token printed on first boot and written to `data/initial-token.txt`
(`0600`). `GET /api/v1/auth/setup` always answers `{ok:true,setupNeeded:false}`;
`POST /api/v1/auth/login` accepts the token in the `password` field and echoes
it back, and `GET /api/v1/auth/me` describes the current token. The `username`
field is ignored — these routes exist so the dashboard's sign-in flow works
unchanged.

**There is exactly one scope: full.** Every token is a full-permission operator
credential — the admin token and keys minted from the Agents panel or
`POST /api/v1/api-keys` are identical in authority. There is no read-only key
and no way to restrict a token. `GET /api/v1/api-keys` reports
`availableScopes: ["full"]` and each key reports `scopes: ["full"]`. Tokens are
stored as SHA-256 hashes and plaintext is shown once at mint time; keys imported
from the previous deployment's bcrypt hashes keep verifying.

**Push token (agents).** A push token is a **second, independent credential**,
created automatically with each `push` monitor (`pushToken` in the monitor JSON,
also returned by `POST /api/v1/monitors`). It is not a bearer token and cannot
call the operator API. It authenticates the agent's posts at
`POST /api/push/{pushToken}` and acts as the fleet whitelist for `/agent/*`:
only a host holding an active monitor's push token can download an agent
update. `/agent/*`, `/add-push-server.md` and `/llms.txt` accept either an
operator bearer token or a push token, via `Authorization` or `?token=`. A
paused monitor (`active: false`) has an unusable push token and is excluded.

## Response envelope and status codes

Success responses carry `"ok": true` plus endpoint data, for example
`{"ok":true,"monitor":{...}}` or
`{"ok":true,"monitors":[...],"count":n,"pagination":{...}}`. Failures use
`{"ok":false,"error":"bad_request","message":"..."}`, where `error` is a stable
machine token (`bad_request`, `not_found`, `unauthorized`, `server_error`,
`stream_limit`) and `message` is human text. Exceptions: the push endpoint uses
`{"ok":false,"msg":"..."}`; badges answer `{"status":"fail","msg":...}` for a
bad id; a gated status page answers `401` with `error:"password_required"` and a
missing page is plain-text `404`.

| Code      | Meaning                                                                      | Where it occurs                                                      |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 200 / 201 | Success / Created                                                            | Reads and updates; `POST` monitors and API keys                      |
| 400       | Validation failure; on push, "metrics dropped"                               | Bad type/`name`/range, bad `hours`/`ids`, invalid metrics            |
| 401       | Missing/invalid/inactive/expired token; locked status page                   | Any `/api/v1` route; gated status-page reads                         |
| 403       | Invalid badge id                                                             | `/api/badge/{id}/...` with a non-numeric or non-positive id          |
| 404       | Unknown resource, unknown/paused push monitor, no metrics, out-of-range ping | `.../{id}`, `POST /api/push/{pushToken}`                             |
| 409       | Not emitted today                                                            | A duplicate `pushToken` hits the unique index but is reported as 500 |
| 413       | Body over the 256 KB limit                                                   | `POST /api/push/{pushToken}`                                         |
| 429       | Too many live SSE connections                                                | `GET /api/v1/events` (`stream_limit`)                                |
| 500       | Storage failure                                                              | Any handler                                                          |

## Endpoint reference

### Auth

| Method | Path                 | Purpose                                  |
| ------ | -------------------- | ---------------------------------------- |
| GET    | `/api/v1/auth/setup` | Public; always `setupNeeded:false`       |
| POST   | `/api/v1/auth/login` | Public; token in `password`, echoed back |
| GET    | `/api/v1/auth/me`    | Validate and describe the bearer token   |

### Monitors, heartbeats and links

| Method | Path                                         | Purpose                                          |
| ------ | -------------------------------------------- | ------------------------------------------------ |
| GET    | `/api/v1/monitor-types`                      | Supported types and `writableFields`             |
| GET    | `/api/v1/monitors`                           | List; `page`, `perPage`, `status`, `active`, `q` |
| POST   | `/api/v1/monitors`                           | Create a monitor                                 |
| GET    | `/api/v1/monitors/{id}`                      | One monitor with live status and uptime          |
| PATCH  | `/api/v1/monitors/{id}`                      | Partial update (type is immutable)               |
| DELETE | `/api/v1/monitors/{id}?deleteChildren=true`  | Delete, optionally a group subtree               |
| GET    | `/api/v1/monitors/{id}/heartbeats?limit=`    | Recent heartbeats, newest first                  |
| POST   | `/api/v1/monitors/{id}/push-failures/clear`  | Acknowledge `failedPushes`                       |
| POST   | `/api/v1/monitors/{id}/agent-warnings/clear` | Acknowledge all agent warning counters           |
| GET    | `/api/v1/monitors/links?ids=1,2,3`           | Bulk links for many monitors (max 200)           |
| GET    | `/api/v1/monitors/{id}/links`                | Raw and resolved links                           |
| PUT    | `/api/v1/monitors/{id}/links`                | Replace; body `{"linkedMonitorIds":[1,2]}`       |
| DELETE | `/api/v1/monitors/{id}/links`                | Clear all links                                  |

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
| GET            | `/api/v1/api-keys`           | List keys (metadata only)                                |
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

Gated reads answer `401` until unlocked. The unlock route accepts JSON
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
a public status-page group get real values, and everything else is grey `N/A`.

### Provisioning and agent downloads

Outside `/api/v1`, authenticated by an operator token or a push token.

| Method | Path                  | Purpose                                          |
| ------ | --------------------- | ------------------------------------------------ |
| GET    | `/add-push-server.md` | Runbook, rendered with origin, token and version |
| GET    | `/llms.txt`           | Pointer file for LLM crawlers                    |
| GET    | `/agent/install.sh`   | Pre-credentialed installer/updater               |
| GET    | `/agent/version`      | Version, size, SHA-256 and URL per platform      |
| GET    | `/agent/sha256sums`   | Checksums for the shipped builds                 |
| GET    | `/agent/{file}`       | One `superboard-<os>-<arch>` binary              |
| GET    | `/robots.txt`         | Public; advisory `Disallow: /`                   |

### Health, live events and the agent push

| Method    | Path                    | Purpose                                           |
| --------- | ----------------------- | ------------------------------------------------- |
| GET       | `/api/v1/health`        | Totals: up/down/pending/paused and `downMonitors` |
| GET       | `/api/v1/events`        | SSE stream; `?metrics=0` drops metrics events     |
| GET, POST | `/api/push/{pushToken}` | Agent heartbeat plus optional metrics             |

## The push contract

`POST /api/push/{pushToken}` (GET is also accepted for legacy agents) selects an
active monitor by token in the path; a missing or paused monitor answers `404`.

- Query: `msg` (default `OK`), `ping` (finite milliseconds; out of range answers
  `404`), `status` (`up` by default, anything else is `down`).
- Body (optional JSON): a `metrics` field holding any non-null JSON sample,
  limited to 64 KB; the whole body is limited to 256 KB (`413` beyond that).
- A legacy POST/GET records a heartbeat, then stores metrics. If the metrics are
  rejected the answer is `400` with "Heartbeat recorded, metrics dropped: ..." —
  the heartbeat stands.
- `?telemetry=1` (POST with metrics) takes a fast path: while the previous beat
  is UP and the heartbeat spacing (one third of the interval, clamped to 1–30s)
  has not elapsed, the sample is stored **without** a heartbeat row and the
  answer is `{"ok":true}`. A metrics failure here answers `400` ("Metrics
  dropped: ...") because no heartbeat was written.

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
- **Heartbeats** — `limit` defaults to 100 and is capped at 1000; `total` is the
  true stored count.
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
