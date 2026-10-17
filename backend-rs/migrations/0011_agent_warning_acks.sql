-- Agent-warning acknowledgements, migration 11.
--
-- The Go agent reports three cumulative counters since its process start:
-- `agent.failedPushes` (acknowledged by `push_failures_ack`, migration 6),
-- `agent.samplesDropped` and `agent.collectorErrors`, a map of collector name
-- to failure count. The operator asked to clear the other two the same way,
-- so each gets its own acknowledgement column.
--
-- `samples_dropped_ack` mirrors `push_failures_ack`: a scalar the board
-- subtracts from the reported counter. `collector_errors_ack` is a JSON
-- object of per-collector acknowledged counts, because that counter is a map.
--
-- The counters reset when the agent restarts, so the ingest path drops an ack
-- whenever a sample reports a lower value than the stored one, exactly like
-- push failures: a stale ack must never hide new warnings.

ALTER TABLE monitors ADD COLUMN samples_dropped_ack INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN collector_errors_ack TEXT NOT NULL DEFAULT '{}';
