-- Indexes for the storage audit (October 2026), migration 14.
--
-- `metrics_hourly_time_idx`: the rollup reads stored buckets for a time
-- window, the verified raw prune reads coverage below the cutoff, and the
-- long-tier prune deletes by time — all fleet-wide, filtering on `time`
-- alone. The only index was `UNIQUE (monitor_id, time)`, so each of those
-- scanned the whole table (and the prune did it under the write lock).
-- `monitor_id` and `samples` make the coverage reads index-only.
--
-- `heartbeats_time_idx`: retention finds the monitors with beats older than
-- the cutoff without scanning the table; the per-monitor batched deletes
-- then use the existing `(monitor_id, time DESC)` index.

CREATE INDEX metrics_hourly_time_idx ON metrics_hourly (time, monitor_id, samples);

CREATE INDEX heartbeats_time_idx ON heartbeats (time);
