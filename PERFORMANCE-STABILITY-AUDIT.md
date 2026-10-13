Performance and stability audit — 2026-10-13

Reviewed revision: `a742b498`. Scope: the Node backend, Rust backend, Go agent, React dashboard, shared client, database schemas/migrations, background jobs, deployment configuration, and supporting scripts/tests. Security findings are excluded. This is a repository-wide review of the execution paths and their failure modes, not a claim that every possible defect has been found.

P1 means a failure can stop monitoring/delivery or lose history in an affected configuration. P2 means a conditional availability problem, misleading monitoring behavior, resource leak, or scaling regression. “Reproduced” refers to isolated local fixtures, not production experiments; “source-traced” identifies findings established from the implementation without a full end-to-end reproduction.

1. **P1 — Hourly rollups lose other monitors' history and fail to incorporate older backfills.**

   Sources: `server/metrics-rollup.js:170`, `server/metrics-rollup.js:195`, `backend-rs/src/metrics/rollup.rs:168`, `backend-rs/src/metrics/rollup.rs:204`.

   Both jobs track coverage by hour alone, although durable buckets are keyed by `(monitor_id, time)`. After storing the first monitor in an hour outside the two-hour overlap, the loop marks that hour covered and skips the other monitors. A later run also treats it as complete. Buffered samples arriving more than two complete hours late are similarly omitted from existing buckets, even though ingestion accepts up to 30 days of backfill. Raw pruning eventually makes these losses permanent.

   **Reproduced in both backends using real SQLite:** three monitors in the same four-hour-old window produced one hourly bucket; running the job again did not repair it. The existing integration coverage exercises one monitor and recent overlap hours.

   Fix: track coverage per monitor and hour, and record dirty hours when late raw samples arrive. Repair existing missing/incomplete rollups before pruning their raw evidence.

2. **P1 — A rejected sample blocks the agent's buffered delivery queue.**

   Sources: `superboard/run.go:147`, `superboard/run.go:161`, `superboard/push.go:91`.

   `push()` distinguishes HTTP 400 with `pushRejectedError`, but the live `deliverBuffered()` loop retries every error without dropping or quarantining the entry. Consequently, one permanently invalid payload blocks all healthy samples behind it. The rejection-aware `pushWithBackoff()` helper is not used by this loop. It can remain blocked across restarts until the entry is removed or capacity eviction reaches it. HTTP 413 from the transport body limit has the same retry problem.

   **Reproduced:** a mock server rejected sample 1 and accepted sample 2; sample 1 was retried four times, sample 2 was never sent, and both remained queued.

   Fix: classify permanent payload errors separately from transient delivery errors, discard/quarantine them with a drop count, and continue draining. Treat invalid credentials/configuration separately so they are visible without silently deleting an entire backlog.

3. **P1 — PostgreSQL and gRPC checks can wait indefinitely, stopping their monitor loops.**

   Sources: `server/monitor-types/postgres.js:49`, `server/monitor-types/grpc.js:61`, `server/model/monitor.js:875`, `server/model/monitor.js:1080`.

   PostgreSQL does not propagate `monitor.timeout` to connection/query deadlines. gRPC calls `makeUnaryRequest()` without a deadline. The common monitor loop awaits these checks and schedules the next check only after they finish; it does not impose an outer deadline. A server that accepts a connection but stops answering can therefore leave the last status visible indefinitely, without further beats or failure alerts.

   **Reproduced for PostgreSQL:** a local TCP server accepted the connection and never answered; a monitor with a 10ms timeout was still pending after 150ms. gRPC's missing deadline is source-traced.

   Fix: apply connection and operation deadlines, cancel outstanding work on timeout/stop, and guarantee resource cleanup. A bare `Promise.race()` without cancellation would still leave the underlying operation running.

4. **P1 — A hung Telegram request can stop a Node monitor and prevent heartbeat persistence.**

   Sources: `server/notification-providers/telegram.js:102`, `server/model/monitor.js:1437`, `server/routers/api-router.js:155`.

   Telegram posts have neither a configured timeout nor an abort signal. The installed Axios default is `timeout: 0`. Monitor and push transition paths await notification delivery before storing the heartbeat and completing the check. A Telegram endpoint/proxy that accepts the connection without replying can therefore freeze a monitor at a transition or leave a push request unfinished. Metric-alert tasks can also remain pending indefinitely.

   **Reproduced:** a local HTTP server accepted the Telegram request and withheld its response; delivery remained unresolved until the fixture closed the socket. No deadline was configured.

   Fix: set an explicit bounded delivery deadline and persist/publish the observed heartbeat independently of notification delivery. Use a bounded notification queue if delivery is asynchronous.

5. **P1 — A hanging REST snapshot disables the dashboard's SSE recovery.**

   Sources: `apps/dashboard/src/lib/api.ts:65`, `apps/dashboard/src/lib/api.ts:215`, `apps/dashboard/src/lib/api.ts:237`, `apps/dashboard/src/lib/api.ts:258`.

   `watchLive()` awaits the snapshot callback inside its stream reader. Its watchdog only aborts the stream request; roster/bulk snapshot requests have no deadline or shared cancellation signal. If a snapshot never resolves, the reader never reaches its reconnect handler. `connected` remains true, suppressing fallback polling. The catch-path snapshot can also indefinitely prevent scheduling a retry.

   **Reproduced with controlled browser APIs and an accelerated watchdog:** the stream was aborted, but there was still only one connect attempt, one unresolved snapshot, and no error callback/reconnect.

   Fix: pass cancellation/deadlines through the entire snapshot, make stream recovery independent of snapshot completion, and prevent overlapping fallback snapshots.

6. **P2 — An empty Docker container name list crashes the whole Go agent.**

   Source: `superboard/docker.go:337`.

   The collector reads `item.Names[0]` before testing `len(item.Names) == 0`. The intended ID fallback cannot run. Empty/missing names in a daemon response cause a bounds panic; this collector runs in a goroutine without recovery, so the process terminates and all host telemetry stops. Its fallback also assumes the ID contains at least 12 characters.

   **Reproduced:** a Unix-socket Docker fixture returning `Names: []` produced `runtime error: index out of range [0] with length 0`.

   Fix: validate the name slice and ID length before indexing/slicing. An incomplete container entry should degrade that entry rather than terminate host monitoring.

7. **P2 — Failed MongoDB commands leak their connected clients.**

   Source: `server/monitor-types/mongodb.js:57`.

   `client.close()` executes only after `db().command()` succeeds. A command error skips cleanup, while the monitor retries with a newly connected client. Repeated invalid queries, privilege/configuration errors, or command failures accumulate connection-pool resources and background activity in the monitoring process and database.

   **Reproduced with a client fixture:** throwing from the command left `close()` uncalled.

   Fix: put cleanup in `finally`, and use bounded selection/command timeouts.

8. **P2 — Every gRPC check creates a channel that is never closed.**

   Sources: `server/monitor-types/grpc.js:53`, `server/monitor-types/grpc.js:56`.

   `constructGrpcService()` allocates a new `grpc.Client` for every check and hides it in the protobuf service callback. Neither success, error, nor monitor stop closes the underlying client. Repeated checks accumulate channel objects, registrations, and associated timers instead of reusing or disposing of them. The installed grpc-js implementation can share underlying connections through its subchannel pool; the finding does not assume a separate socket for every check. This is separate from the missing request deadline.

   **Source-traced.** Fix: retain a reusable client per monitor with explicit stop/reconfiguration cleanup, or return a cleanup handle and close it in `finally` after each check.

9. **P2 — Rust heartbeats have no retention/pruning job.**

   Sources: `backend-rs/src/heartbeats.rs:215`, `backend-rs/src/metrics.rs:118`, `backend-rs/src/lib.rs:89`.

   Every completed check adds a heartbeat. Startup schedules metrics rollups and raw-metrics pruning, but no heartbeat retention job exists; heartbeats disappear only with monitor deletion. A long-lived monitor therefore grows its database history without a bound. At a 20-second check interval this adds about 1.58 million rows per monitor per year, excluding retries. Storage and historical query costs continue increasing.

   **Source-traced across Rust startup, jobs, schema, and heartbeat mutations.** Fix: introduce configurable heartbeat retention, preserve a boundary sample/state transitions needed for uptime, and persist aggregate uptime if longer history must survive raw pruning.

10. **P2 — Rust latest-heartbeat reads scan complete monitor histories.**

   Source: `backend-rs/src/api/monitors.rs:108`.

   `latest_beats()` ranks every heartbeat for the requested monitor IDs with `ROW_NUMBER()` and then selects `rn = 1`. List and detail responses therefore perform work proportional to historical rows, despite needing only one indexed row per monitor. This compounds the absent heartbeat retention. The existing `(monitor_id, time DESC)` index can instead support bounded lookups.

   **Measured in an isolated SQLite fixture:** 100,000 rows across ten monitors took approximately 88ms with the ranking query versus 0.19ms with indexed per-monitor `LIMIT 1` subqueries. These are local illustrative timings, not production capacity predictions.

   Fix: select each monitor's newest heartbeat through an indexed scalar/correlated subquery or maintain a current-heartbeat reference.

11. **P2 — Rollup batches can load almost the whole raw-retention window and perform full-table scans.**

   Sources: `server/metrics-rollup.js:183`, `backend-rs/src/metrics/rollup.rs:190`, `db/knex_migrations/2026-10-07-0000-monitor-metric.js:36`, `backend-rs/migrations/0003_metrics.sql:15`.

   `CHUNK_HOURS = 6` bounds the number of missing-hour entries, not elapsed time. If one old hour is missing and intervening hours are covered, a chunk stretches from that old gap through the recent overlap and fetches all full JSON payloads in between. Both implementations materialize the result and aggregate it in memory. Their raw metrics indexes start with `monitor_id`, while fleet-wide rollup/prune queries filter only on `time`; these queries lack a suitable leading time index.

   **Reproduced:** one old gap produced a 696-hour query window despite the six-hour constant. SQLite `EXPLAIN QUERY PLAN` reported `SCAN metrics_raw` for the implemented time-range query.

   Fix: bound actual elapsed windows and row/page sizes, aggregate incrementally, and add indexes appropriate for fleet-wide time-range retention work.

12. **P2 — Concurrent ingestion bypasses the 30-second archive gate.**

   Sources: `server/monitor-metrics.js:186`, `server/monitor-metrics.js:289`, `server/monitor-metrics.js:306`, `backend-rs/src/metrics/ingest.rs:96`, `backend-rs/src/metrics/ingest.rs:246`.

   Each request reads the previous cached archive clock before awaiting storage/peak work and updates that clock afterwards. Concurrent requests for the same monitor can all decide that persistence is due. Rust's mutex protects individual cache reads/writes but does not serialize the read/derive/persist/update operation. Duplicate archives increase writes and weight those timestamps repeatedly in historical statistics; counter-window state can also be based on the same obsolete previous sample.

   **Reproduced in Node with delayed persistence:** ten concurrent identical live samples produced ten archive writes instead of one. Rust shares the same source-traced race. The normal single-sender Go path is serialized; overlapping senders/requests trigger this issue.

   Fix: serialize ingestion per monitor or reserve/update archive state atomically with a failure rollback strategy; make sample storage idempotent where appropriate.

13. **P2 — Resource-alert debounce does not require a sustained breach.**

   Sources: `server/metric-alerts.js:91`, `backend-rs/src/metrics/alerts.rs:104`.

   A value below the alert threshold but above the recovery threshold leaves `breachedSince` unchanged even before an alert has fired. Missing readings do the same. Two short spikes separated by a minute below the threshold can consequently trigger the advertised 60-second sustained-breach alert. Hysteresis makes sense for an already-alerted episode; it should not silently count sub-threshold time toward initial debounce.

   **Reproduced in Node's state machine:** with threshold 90, `95% @ 0s`, `88% @ 1s`, and `95% @ 61s` returned an alert on the last sample. Rust implements the same branches.

   Fix: reset initial debounce when the reading falls below the threshold, and define how long gaps/unknown readings interrupt continuity. Apply hysteresis after an alert is active.

14. **P2 — Buffered historical samples can generate current resource alerts.**

   Sources: `server/metric-alerts.js:193`, `server/routers/api-router.js:111`, `backend-rs/src/metrics/alerts.rs:198`, `backend-rs/src/api/push.rs:137`, `superboard/run.go:147`.

   Alerts evaluate the newest cached sample against receive time without checking sample freshness. A reconnecting agent drains old readings oldest-first at roughly 20 samples/second. If a historical high-load stretch takes over a minute to drain, it can satisfy the debounce and send an alert while the host's present load has already recovered. Old low readings can likewise cause a misleading recovery. Using receive time alone does not prevent this once a backlog lasts longer than the debounce.

   **Source-traced through buffered delivery, sample timestamps, ingest, and alert evaluation.** Fix: archive backfill but only evaluate current alerts from sufficiently fresh samples; clear/pause debounce across stale telemetry and resume it from live readings.

15. **P2 — Login has no in-memory fallback when browser storage is unavailable.**

   Sources: `apps/dashboard/src/lib/api.ts:17`, `apps/dashboard/src/lib/api.ts:29`.

   `setToken()` swallows storage errors with a comment promising that the current session continues to work, but there is no memory copy. `getToken()` returns null when storage throws, and subsequent API/SSE requests omit the token. A successful login therefore immediately returns to an unauthenticated state in browsers/environments that block or fail local storage. This finding concerns availability, not credential-storage security.

   **Reproduced:** storage methods throwing an exception left `getToken()` null immediately after `setToken('session-token')`.

   Fix: keep a module/session token in memory, optionally persist it, and clear both on logout.

16. **P2 — Node's legacy zero-timeout fallback multiplies the timeout by 1,000 twice.**

   Sources: `server/model/monitor.js:468`, `server/model/monitor.js:564`, `server/model/monitor.js:577`.

   For an existing monitor whose stored timeout is zero/missing, the runtime sets `this.timeout = this.interval * 1000 * 0.8`. Consumers treat `this.timeout` as seconds and multiply it by 1,000 again. A 60-second interval consequently gets a 48,000-second timeout, roughly 13.3 hours, instead of 48 seconds. This can hold a failing check for hours. New/edited monitors going through `monitor-service` usually receive a proper default, so this specifically affects legacy/otherwise persisted zero-timeout configurations.

   **Source-traced, including the service default that limits the affected cases.** Fix: assign seconds (`interval * 0.8`) in the runtime fallback and normalize existing stored values consistently.

17. **P2 — Rust checks add their execution time to the configured interval.**

   Sources: `backend-rs/src/monitors/engine.rs:176`, `backend-rs/src/monitors/engine.rs:202`, `server/model/monitor.js:1076`.

   Rust waits a full interval after the check and heartbeat publication finish. Node subtracts elapsed check time before scheduling its next check. A Rust HTTP monitor with a 60-second interval and a 48-second failed request therefore checks approximately every 108 seconds, plus recording overhead. Retry intervals drift similarly. Migration silently reduces check frequency and delays outage detection most when targets are already slow.

   **Source-traced comparison of both schedulers.** Fix: schedule relative to the check start using a monotonic clock, with a bounded minimum delay and no overlapping checks.

Validation performed:

- `cargo test --locked`: 96 tests passed across unit and integration suites.
- `go test -race ./...` in `superboard`: passed.
- `node --test apps/dashboard/test/*.test.mjs`: 24 tests passed.
- Seven focused Node backend test files for metrics ingestion, counters, I/O rates, history, rollups, alerts, and monitor service: 81 tests passed.
- Dashboard `npm run typecheck`: passed.
- Isolated reproductions described above used temporary databases, local mock services, controlled browser APIs, or mocked persistence. Temporary Rust reproduction tests were removed; Go reproductions ran in a temporary source copy.
- React Doctor was run using the `react-doctor` skill. It produced diagnostics but reported that maintainability checks failed and results were incomplete. Its security diagnostics and generic style/accessibility suggestions are not counted as findings here.

Existing tests passing does not contradict these findings: the isolated cases expose missing coverage for multi-monitor/older rollups, rejected buffered heads, hanging operations, and concurrent ingestion. Container-backed monitor integration tests, a full Docker image build, and production/fleet load tests were not run. Benchmark timings above are small local fixtures. Application source was not changed by this audit.

Suggested implementation order: repair rollup completeness first while raw evidence still exists; fix buffered rejection handling and bounded check/notification/snapshot recovery next; then address leaks, retention/query scaling, and alert semantics. Each fix should add a regression test for the specific failing scenario rather than only the existing happy path.
