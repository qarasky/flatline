# Performance and stability follow-up — 2026-10-14

Reviewed revision: `2f91ecad`. Scope: the Node and Rust backends, Go agent, React dashboard, metrics/heartbeat storage, background jobs, notifications, and deployment documentation. Security defects and dependency vulnerability findings are excluded; general security requirements appear only in the external-research section.

The earlier `PERFORMANCE-STABILITY-AUDIT.md` records 17 fixes. This review checks current behavior, including remaining gaps in those fixes. `docker/RUST-CUTOVER.md` says the office deployment switched to Rust on October 13 and retains Node for rollback. This was established from repository documentation, not a live deployment inspection. Node-only findings therefore have different operational priority from shared/Rust findings.

**Assessment:** the small live-update workload performs well locally, but history preservation still has reproducible failures. Expensive historical scans, unreliable alert delivery, and slow collector freshness deserve attention before increasing fleet size. Seven findings follow. P1 denotes monitoring stoppage or permanent history loss under the stated conditions; P2 denotes conditional reliability or scaling problems.

## Findings

### 1. P1 — Raw pruning can permanently delete history before rollup repair

Applies to both backends. Sources: `server/monitor-metrics.js:377`, `server/jobs.js:17`, `backend-rs/src/metrics/rollup.rs:405`, `backend-rs/src/metrics.rs:145`.

Raw pruning executes an unconditional time-based DELETE. It neither invokes a repair pass nor verifies that every expired sample is represented in an hourly bucket. Hourly rollup and daily prune are independently scheduled. Starting between 04:12 and 04:27, a failed rollup, or a long-running repair can put deletion ahead of repair. For example, after an outage leaves old unrolled samples, restarting at 04:20 lets pruning run at 04:27 while the next rollup is at 05:12. Scheduling alone does not establish the repair-before-prune guarantee claimed in the previous audit's resolution.

**Reproduced in Node with real in-memory SQLite:** insert an unrolled 31-day-old sample, call the actual `pruneMetrics(30)`, then `rollupMetrics()`. Both raw and hourly tables end empty. Rust's same failure is source-traced.

**Fix:** coordinate rollup and pruning through one maintenance operation, propagate repair failures, and prune only verified complete buckets. Prevent concurrent ingestion/repair from invalidating the completeness decision. Add restart-between-jobs and failed-repair regressions.

### 2. P1 — Redis and MySQL checks can still stop their monitor indefinitely

Node only. Sources: `server/monitor-types/redis.js:11`, `server/monitor-types/redis.js:36`, `server/monitor-types/mysql.js:71`, `server/model/monitor.js:1080`.

Neither check propagates `monitor.timeout` to its Redis command or MySQL query. Connection timeouts do not bound an operation after connection succeeds. The shared monitor loop schedules its next check only after the current check settles. A server that accepts commands but never answers can therefore leave the last heartbeat unchanged and suppress subsequent checks and failure notifications.

**Reproduced separately for both drivers:** local protocol fixtures completed connection setup and received PING / SELECT 1, then withheld the response. With `monitor.timeout = 0.01`, each check was still pending at 250 ms. Source inspection confirms the configured timeout is unused; the short observation alone is not evidence of an infinite wait. The MySQL fixture also emitted a packet-sequence warning while successfully receiving the query.

**Fix:** enforce connection and command deadlines, cancel/destroy the operation on expiry, and close clients in `finally`. Extend the deadline regression coverage beyond the already-fixed PostgreSQL and gRPC types.

### 3. P1 — Late backfill can replace a complete hourly bucket with partial history

Applies to both backends. Sources: `server/metrics-rollup.js:311`, `server/metrics-rollup.js:365`, `server/monitor-metrics.js:377`, `backend-rs/src/metrics/rollup.rs:250`, `backend-rs/src/metrics/rollup.rs:337`.

The 30-day prune cutoff can split an hour. An existing hourly bucket retains the complete hour, but raw rows before the cutoff disappear. If an accepted late sample subsequently marks the surviving portion of that hour dirty, rollup rebuilds the bucket from only the remaining raw rows and overwrites the complete aggregate. The dirty-marker branch bypasses the sample-count safeguard. Historical peaks and means can change permanently even though the old bucket was correct.

**Reproduced in Node with actual rollup/prune functions:** an hour with CPU readings 100 and 0 initially had `samples=2, max=100, mean=50`. After pruning its first reading and adding an eligible late zero reading, rollup returned `samples=2, max=0, mean=0`. Rust uses the equivalent dirty-marker/replacement logic; it was source-traced rather than separately reproduced.

**Fix:** retain complete raw hours through the accepted backfill horizon and coordinate their finalization with ingestion and pruning. Never replace a complete bucket from an incomplete raw set. Incremental merging is another option, but requires per-metric counts/sums and sample deduplication.

### 4. P2 — Transient notification failures permanently discard alerts; Node shutdown does not flush its queue

Applies to both backends for failed delivery; the unused flush helper is Node-specific. Sources: `server/notification-queue.js:66`, `server/server.js:421`, `backend-rs/src/notify.rs:326`, `backend-rs/src/monitors/engine.rs:437`.

Node removes each delivery before sending and only logs failure. Rust likewise logs a failed send without retaining it for retry. A temporary timeout or provider error can lose the only DOWN alert when periodic resend is disabled. In Node, the new queue is memory-only and `flushNotifications()` has no production caller, despite its comment saying shutdown uses it. Shutdown eventually forces process exit, losing any remaining deliveries.

**Reproduced for Node failure handling:** one queued delivery throws a simulated HTTP 503; after draining, attempts=1, pending=0, failed=1. Retry and restart durability are absent in the inspected implementations; shutdown loss was source-traced, not tested by stopping a deployed server.

**Fix:** use a bounded persistent notification outbox, retry transient errors with backoff/jitter and provider retry hints, and expose queue age, failures and drops. Preserve ordering per monitor/recipient. Connect shutdown to a bounded drain; retain unfinished work for restart.

### 5. P2 — Every rollup recounts the entire raw retention window

Applies to both backends; event-loop blocking specifically affects Node's synchronous SQLite driver. Sources: `server/metrics-rollup.js:289`, `server/database.js:334`, `backend-rs/src/metrics/rollup.rs:224`.

The recent pagination fix bounds raw payload reads during aggregation, but the coverage query still groups every retained raw sample by monitor/hour before choosing work. It runs even when nearly all buckets are complete and dirty-hour markers already identify changed data. The time index helps locate the range, but that range is essentially the whole retained dataset.

**Measured locally:** the implemented Node coverage SQL over 864,000 rows—ten hosts, 30 days, 30-second archive cadence—took about **550 ms** in in-memory SQLite. The query plan used the time index plus a temporary GROUP BY tree. This is synchronous database work in the Node process; ingestion, SSE and check scheduling cannot run during that query. Rust also incurs the database/CPU work, although SQLx does not execute SQLite on the Tokio worker in the same manner.

**Fix:** use dirty buckets plus a durable progress watermark for normal operation; run full reconciliation as a separately bounded repair task. Keep repair-before-prune correctness. Benchmark mature datasets, not only empty/new databases.

### 6. P2 — Rust recomputes 30-day uptime on the heartbeat publication path

Rust only. Sources: `backend-rs/src/heartbeats.rs:352`, `backend-rs/src/monitors/engine.rs:153`, `backend-rs/src/monitors/engine.rs:418`.

After the 30-second cache TTL expires, uptime computation uses a window query across the monitor's last 30 days of heartbeats. Heartbeat publication awaits it, and notification dispatch follows publication. Frequent checks therefore repeatedly scan growing history as part of normal monitoring. Concurrent cache misses can also duplicate the same calculation because no shared in-flight computation is retained.

**Measured locally:** the exact Rust SQL over 129,600 heartbeats—one monitor at 20-second intervals for 30 days—took about **92 ms** using SQLite. This measures query cost only, not a Rust HTTP endpoint or a production capacity limit. Multiple monitors and simultaneous misses multiply the work and compete for the five-connection pool.

**Fix:** maintain incremental uptime aggregates or state-transition intervals and keep complete-history calculations off the heartbeat/notification path. Coalesce concurrent cache misses. Retain correctness at window boundaries and across pending/unknown periods.

### 7. P2 — Slow Docker collection can leave old container health looking fresh

Go agent. Sources: `superboard/docker.go:244`, `superboard/docker.go:345`, `superboard/live_collect.go:139`, `superboard/live_collect.go:254`.

Each collection walks containers sequentially, awaiting inspect and then stats for every running container. Each request can take ten seconds, with no overall collection deadline. Ten running containers with both operations stalling can keep a pass busy for roughly 200 seconds, despite the nominal ten-second refresh cadence. During the pass, normal 1 Hz samples keep republishing the previous Docker snapshot under a new whole-payload timestamp. There is no Docker collection timestamp to distinguish fresh host telemetry from old container health.

**Source-traced; not load-reproduced.** The independent collector correctly protects CPU/RAM sampling, but it does not make container health timely.

**Fix:** use bounded parallel requests and an overall collection deadline; retain separate collector timestamps/age and surface stale container data. Test a slow Docker daemon with multiple containers while verifying CPU/RAM pushes continue.

## Published requirements and how they apply

These references describe practices, not a universal hardware minimum or latency SLA. Requirements must specify fleet size, sample rate, payload size, retention, simultaneous viewers, and acceptable data loss.

1. **Tail latency, detection timeliness and useful alerts.** Track latency, traffic, errors and saturation; measure percentiles rather than only means. Choose sampling resolution according to the signal, and ensure alerts are actionable. For this repository that means measuring check scheduling delay, sample age, notification delay and query latency as well as ingestion throughput. [Google SRE: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/).

2. **Bounded storage and explicit durability.** Retention must fit available disk with operational headroom; backups and recovery must account for recent un-compacted data. Local storage is not automatically replicated or resilient to a node/disk failure. Apply these principles to the SQLite database, raw-to-hourly transition, agent spool and restore procedure. Prometheus's bytes-per-sample figures do not transfer to this repository's full JSON payloads. [Prometheus: Storage](https://prometheus.io/docs/prometheus/latest/storage/).

3. **Backpressure and outage recovery.** Network delivery should have bounded queues, configurable retry/backoff, visible queue/failure metrics, and persistence where restart loss is unacceptable. Queue capacity must reflect the expected outage duration and arrival rate. This applies to telemetry and, by analogy, the notification outbox proposed above. [OpenTelemetry Collector: Resiliency](https://opentelemetry.io/docs/collector/resiliency/).

4. **Security requirements only—not security findings.** Define who can view telemetry, modify monitoring configuration and access administrative endpoints; protect monitoring credentials and use authenticated encrypted connections across trust boundaries. A monitoring system's data and control surface need an explicit trust model. [Prometheus: Security Model](https://prometheus.io/docs/operating/security/).

5. **REST security baseline.** Require HTTPS, enforce authorization at each non-public endpoint, restrict management endpoints, validate requests, and audit sensitive operations without logging credentials. These are requirements to evaluate in a separate security pass; this review does not assert that the repository violates them. [OWASP: REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

**Proposed acceptance criteria for this project:** validate an explicitly declared fleet envelope, initially for example 100 hosts at 1 Hz with ten viewers and 30 days of populated history. Candidate targets are p95 ingestion-to-stream below 250 ms, p95 dashboard/history reads below two seconds, bounded completion of every check, and live freshness within a few sample intervals. These numbers are engineering proposals, not thresholds mandated by the references or demonstrated by this audit. Repeat during rollup/prune, agent backlog drain, slow clients and a provider outage. Specify availability, recovery time and permissible data loss separately, and exercise restart/restore tests.

At the present 30-second archive interval, each host creates about 86,400 raw metric rows in 30 days. One hundred hosts create 8.64 million rows; assuming a 4 KiB average payload, payload bytes alone are about 33 GiB before indexes, heartbeats, WAL and database overhead. Measure actual payload sizes—container inventories and per-core data can change this substantially. Buffer outage coverage similarly equals buffer capacity divided by measured bytes per second, not a fixed number of hours.

## Validation and limits

- Focused Node suites for rollups, metrics ingestion/read APIs, metric alerts and notification queue: **70 tests passed**.
- Rust: `cargo test --locked` passed.
- Go: `go test -race ./...` passed.
- Dashboard: **28 tests passed**.
- Existing isolated Node benchmark: ten hosts at 1 Hz, three SSE clients, ten seconds; **300/300 deliveries**, ingestion-to-stream p50 **25.3 ms**, p95 **30.1 ms**, event-loop p95 **12.1 ms**. This is a small fresh-database Node baseline, not a Rust/deployed-fleet result or browser-paint measurement.
- Additional isolated reproductions and SQL timings are recorded with the individual findings. They used in-memory databases and loopback services, not deployment data.
- React Doctor scanned 37 files but exited with incomplete maintainability analysis and no score. Its security, style and unvalidated heuristic warnings were not promoted to findings. For example, the reported stale-load warning has an existing epoch guard in `App.tsx`.
- No production load, full Docker image build, external database container matrix, or long-running soak test was performed. Passing existing tests does not cover the newly reproduced edge cases.

Only this report was added; application code was not changed. For the documented Rust deployment, address shared history preservation first, then notification reliability and historical-query costs. Address Node database-check deadlines before relying on those monitor types or rolling back to Node.
