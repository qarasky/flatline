-- Rollup coverage groundwork, migration 7.
--
-- `metrics_rollup_dirty` records the hours whose hourly bucket may have
-- become stale: a buffered agent can deliver a sample into an hour that a
-- previous rollup run already folded, and the marker makes the next run
-- re-fold that hour instead of trusting its age. The unique key makes the
-- ingest-side write an idempotent upsert, and the cascade keeps markers for
-- deleted monitors from lingering.
--
-- `metrics_raw_time_idx` indexes the raw table by time first. The existing
-- `(monitor_id, time DESC)` index serves per-monitor history reads, but the
-- rollup's coverage scan and the raw prune filter fleet-wide on time alone;
-- without a time-leading index they degrade to table scans that read every
-- payload.

CREATE TABLE metrics_rollup_dirty (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    -- Hour bucket start, UTC, stored like every other metric timestamp.
    hour       TEXT NOT NULL,
    UNIQUE (monitor_id, hour)
);

CREATE INDEX metrics_raw_time_idx ON metrics_raw (time, monitor_id);
