# Rust backend — assessment

Status: **evaluation only, nothing implemented.** Written 2026-10-12 after
the v2 consolidation, at the user's request to weigh a Rust rewrite of the
Node backend. This document is the honest cost/benefit first, before any
code.

## What exists today

After the v2 consolidation the runtime story is much smaller than it was:

- **One container, one Node process** serves the API, the operator
  dashboard and the public status pages (no Next.js, no gateway, no
  separate frontends).
- The Go agent is a single static binary and needs no Node at all.

The backend itself, which a rewrite would have to replace:

| Piece | Size | Notes |
|---|---|---|
| `server/` | 114 files, ~25k lines JS | Express + redbean/knex on SQLite |
| Monitor engine | `model/monitor.js` 2030 lines, 27 monitor types | scheduling, retries, maintenance, notifications |
| Uptime calculator | 906 lines | rolling 24h/7d/30d uptime, ping aggregates |
| Auth | better-auth (TS) + auth-router + invites + API keys + TOTP | the least portable piece |
| REST API v1 | 7 routers + OpenAPI | the contract a rewrite must keep |
| Telemetry pipeline | ingest, hourly rollups, threshold alerts, SSE | rebuilt three times this year; stable now |
| Tests | 341 `test()` calls across 34 backend suites | the parity harness a rewrite gets for free |
| Supply chain | 102 direct npm deps, ~599 MB node_modules | inherited; 12 production advisories outstanding |

## What Rust would buy

1. **Supply chain.** The strongest practical argument. Today's runtime pulls
   ~600 MB of npm packages and a steady advisory stream for a fork whose
   actual dependency needs (HTTP server, SQLite, HTTP client, TLS) are a
   handful of crates. A Rust build is auditable and reproducible.
2. **Deployment weight.** Release image is Node (~150 MB+); a Rust binary
   with the SPA embedded (rust-embed) lands in the tens of MB with a
   fraction of the RAM. Matters on tiny VPS hosts; matters less on office.
3. **One language with the agent.** The agent is Go today, not Rust — so
   this argument only holds if the agent is rewritten too. The agent is 26
   files / ~4.7k lines and would be the *easy* half of such a project.
4. **No Node version gates, no `tsx` loader, no dual module systems.**
   Today's server boots through `--import=tsx` only because a few
   TypeScript files exist; that friction disappears.

## What it costs

1. **Auth is the hidden mountain.** better-auth currently provides password
   hashing, sessions, TOTP, API keys, ban/unban and invite plumbing. Rust
   has no drop-in equivalent: this is a hand-written implementation
   (argon2, opaque tokens hashed at rest, TOTP per RFC 6238, account admin)
   plus a data migration for existing `better_auth_*` tables.
2. **27 monitor types with edge behaviour.** Each is small; collectively
   they encode years of quirks (redirect handling, accepted status codes,
   keyword/json-path semantics, per-type retry rules). Crates exist for
   most protocols (reqwest, hickory-dns, rumqttc, rdkafka, redis), but
   parity work and tests are the bulk.
3. **Telemetry pipeline is deceptively deep.** The Phase 1–5 logic
   (counter deltas, `sampledAt` backfill, hourly rollups with min/max/avg,
   threshold state machines, SSE fan-out with bounded buffers) is subtle and
   was debugged in production. Porting it means re-earning that correctness.
4. **Dual maintenance during migration.** Unless the cutover is a big bang,
   two backends run side by side against one SQLite file — two writers to
   one schema is exactly the kind of fragility the consolidation just
   removed.
5. **The long tail nobody sees.** cloudflared integration, upload handling,
   status-page unlock cookies, Prometheus endpoint, badge endpoints, the
   migration runner for existing installs (30+ knex migrations), i18n
   leftovers.

**Honest estimate:** a solo full rewrite to parity is a multi-month project
with a long tail, even with the API contract and test suite as a harness.
The current backend is not slow, not unstable, and now runs as one process.

## Migration shapes

| Shape | What | Verdict |
|---|---|---|
| **A. Strangler: telemetry domain only** | Rust service owns agent ingest, rollups, alerts, read API, SSE; Node keeps monitors/UI/auth | Clean boundaries exist, but it re-divides the system into two runtimes and splits schema ownership. Contradicts the v2 goal |
| **B. Full rewrite behind the frozen contract** | Same HTTP surface (v1 + push + status-page + SSE), internals rewritten; OpenAPI + 341 tests as parity harness | The only shape that ends in one language; multi-month, big-bang risk unless phased per router |
| **C. Feature-freeze rewrite** | New Rust core covering only the features actually used; unused monitor types dropped (the fork already deleted 108 notification providers and the whole Vue frontend) | **Most defensible.** Shrinks the parity matrix before writing a line |

## Recommendation

1. **Do not start a rewrite today.** The consolidation just removed most of
   the operational pain (one process, one image); the remaining Node cost is
   supply chain, not runtime.
2. **If pursuing, choose shape C** and start with measurement, not code:
   - Query the production DB for which monitor types, notifications and API
     routes are actually used. The office fleet is ~10 push monitors and one
     website check — that suggests a Rust core of push + http + ping + dns
     would cover reality, not 27 types.
   - Define the parity matrix from that measurement; freeze the Node backend
     as the reference implementation.
3. **Sequencing that keeps risk honest:** skeleton (axum + sqlx + SPA embed)
   → auth → push/http monitors + Telegram → telemetry pipeline (port Phase
   1–5 with the same tests) → status pages → only then evaluate long-tail
   monitor types. Keep the Node image deployable until the Rust core passes
   the adapted suites against a copy of the production database.
4. **Decide the agent question up front.** A Rust backend with a Go agent is
   still two languages; if "one language" is the goal, budget the agent
   rewrite (~4.7k lines) as part of the same arc.

## Target stack (if greenlit)

| Need | Choice |
|---|---|
| HTTP | `axum` + `tokio` + `tower` middleware |
| SQLite | `sqlx` (async, migrations) — schema parity with the knex migrations |
| SPA | `rust-embed` (the v2 build is already a static bundle) |
| Telegram | `reqwest` + the existing template semantics |
| Auth | `argon2` + opaque hashed tokens + `totp-rs`; migrate `better_auth_*` rows |
| SSE | `axum` streaming with the same bounded-buffer rules |
| Agent (later) | port `superboard/` crate-for-crate; it is the smaller half |

## Decision checklist

- [ ] Which monitor types and API routes are actually used (measure the DB)
- [ ] Is dual-language (Rust backend + Go agent) acceptable, or is the agent
      in scope too?
- [ ] Who maintains the auth replacement (TOTP, invites, key rotation)?
- [ ] Appetite for dual maintenance during migration
- [ ] Rust toolchain in the build/deploy path (cross-compile like the agent)
