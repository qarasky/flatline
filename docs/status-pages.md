# Status pages

A status page is a public, read-only view of a set of monitors: an overall
status hero, incident cards, and monitor groups with heartbeat bars. Pages live
in the dashboard app and are served by the backend on the same origin, under
`/status/:slug` and on host-mapped client domains.

## How a page is reached

| Path                 | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `/status/:slug`      | The page itself (SPA route).                 |
| `status.client-a.kz` | Same page, resolved from the request `Host`. |

`GET /api/status-page/resolve-host?host=…` maps a hostname (with or without
port) to a page slug; the SPA uses it on a branded domain so one deployment can
serve several client domains. Unknown hosts — and hosts mapped to an unpublished
page — match nothing rather than falling back to a default page.

## Reading a page (public, no token)

| Endpoint                                       | Returns                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/status-page/{slug}`                  | Page config, public groups with their monitors, incidents, maintenance list. |
| `GET /api/status-page/heartbeat/{slug}`        | Recent heartbeat rows and uptime windows per monitor.                        |
| `GET /api/status-page/{slug}/incident-history` | Cursor-paginated incident history.                                           |
| `GET /api/status-page/{slug}/manifest.json`    | Web app manifest (title and icon).                                           |
| `GET /api/status-page/{slug}/badge`            | A badge for the page.                                                        |

These endpoints are public by design: a status page exists to be read by people
who are not operators. They expose status, latency and uptime — **not** the
operator's message text, which is stripped from public heartbeat rows.

Only **published** pages are public. An unpublished page answers `404` on every
endpoint above and on the unlock route, exactly like a slug that does not exist,
so its existence is not confirmed. A request with a valid operator bearer token
(`Authorization: Bearer …`) still gets the data, for previews and tooling; the
dashboard's `/status/:slug` view sends no token, so it shows published pages
only.

Responses are cached for 10 seconds (pages refresh every 30), so a new heartbeat
or an edited title can take that long to appear. The published flag and the
password are checked on every request: unpublishing or locking a page applies
immediately. The status-page and badge routes share an instance-wide limit of 16
requests in flight; a flood is answered `429` with `Retry-After` rather than
starving the database.

## Password gate

A page may carry a password. Reads then answer `401` with
`WWW-Authenticate: Form` and `{"error":"password_required"}`, and the browser
shows an unlock form.

`POST /api/v1/status-pages/unlock/{slug}` with `{"password":"…"}` answers `302`
and sets an `HttpOnly`, signed, page-scoped cookie (`fl_status_auth`), which is
what grants access to that one page. It never grants operator access, and a
wrong password gets an HTML prompt rather than a JSON error, because a human is
looking at it.

Password gating is the real protection; the indexing headers below are
advisory.

## Indexing

Every status page is `noindex, nofollow, noarchive, nosnippet`, the responses
carry an `X-Robots-Tag`, and `robots.txt` disallows the whole site. Compliant
crawlers stay out; a determined one is not stopped by any of it — treat
unpredictable slugs plus the password as the actual boundary.

## Branding

Each page carries a title, an icon (defaulting to the Flatline mark at
`/icon.svg`) and an optional accent colour. The accent is applied as a CSS
variable scoped to the page, and the status palette stays fixed and semantic —
up green, degraded amber, outage red — and is never derived from the accent, so
a client's brand colour can never be mistaken for a status.

## Badges

Per-monitor SVG badges are served from `/api/badge/{id}/{metric}`, where metric
is `status`, `uptime`, `ping`, `response` or `avg-response`; each accepts an
optional `/{duration}`. A monitor that is not on a public group of a published
page renders `N/A` rather than leaking private status. A non-numeric id answers
a JSON `403`, like the rest of the legacy badge surface; an invalid or absurdly
large duration answers `400`, and long windows are clamped to the heartbeat
retention.

## Data model

| Table                   | Holds                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `status_pages`          | Slug, title, icon, published flag, optional password hash, branding.        |
| `status_page_groups`    | Sections within a page, with a `public` flag and ordering.                  |
| `status_page_monitors`  | Which monitors appear, in which section, and whether the check URL is sent. |
| `status_page_cnames`    | Host → page mappings for branded domains.                                   |
| `status_page_incidents` | Incident posts: style, title, content, pin, active, timestamps.             |

## Editing a page

The API is deliberately read-only here: it serves pages, unlocks them and
renders badges — there are no create/update/publish endpoints for pages,
groups, domains or incidents. Configuring a page is currently a database
operation (historically an import from the previous backend). If page
administration is needed over HTTP, it is a new surface, not a switch to flip;
see [roadmap](roadmap.md).
