-- Push-failure acknowledgement, migration 6.
--
-- The Go agent reports `agent.failedPushes` as a counter since its process
-- start (payload.go: cumulative, resets on restart). The operator asked for
-- a way to clear those failures once seen, so the server stores the counter
-- value that was last acknowledged here. The dashboard shows
-- `failedPushes - push_failures_ack` (never below zero), and
-- `POST /api/v1/monitors/{id}/push-failures/clear` sets the ack to the
-- latest reported value.
--
-- The counter resets when the agent restarts, so the ingest path drops the
-- ack whenever a sample reports a lower value than the stored one: a stale
-- ack must never hide new failures.

ALTER TABLE monitors ADD COLUMN push_failures_ack INTEGER NOT NULL DEFAULT 0;
